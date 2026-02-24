// Workspace CRUD and state management
// Workspaces are stored as split keys in chrome.storage.sync (v2 format):
//   ws_meta  → { order: [...], version: 2 }
//   ws_{id}  → { id, name, icon, color, colorScheme, pinnedBookmarks, shortcuts, created }
// Device-local state (activeWorkspaceId, rootFolderIds) stored in chrome.storage.local.
// Each workspace maps to a Chrome bookmark folder under "Arc Spaces".
// This service OWNS all first-run initialization (not the service worker).

import { storageService } from './storage-service.js';
import { bookmarkService } from './bookmark-service.js';
import { bus, Events } from '../utils/event-bus.js';

const SHORTCUTS_FOLDER_NAME = '__shortcuts__';

/**
 * Regex to match a single emoji (or ZWJ sequence) at the start of a string,
 * followed by a space. Covers most common emoji including skin tones and flags.
 */
const EMOJI_PREFIX_RE = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*\s/u;

/**
 * Extract an emoji prefix from a bookmark folder title.
 * @param {string} title
 * @returns {{ emoji: string, name: string }}
 * @example extractEmojiPrefix("🏠 Personal") → { emoji: "🏠", name: "Personal" }
 * @example extractEmojiPrefix("Personal")    → { emoji: "",   name: "Personal" }
 */
function extractEmojiPrefix(title) {
  const match = title.match(EMOJI_PREFIX_RE);
  if (match) {
    const emoji = match[0].trimEnd();
    const name = title.slice(match[0].length);
    return { emoji, name };
  }
  return { emoji: '', name: title };
}

/**
 * Build a bookmark folder title from a name and optional emoji.
 * @param {string} name
 * @param {string} emoji
 * @returns {string}
 */
function buildFolderTitle(name, emoji) {
  if (emoji) return `${emoji} ${name}`;
  return name;
}

const WORKSPACE_COLORS = [
  { name: 'purple', color: '#7C5CFC', light: '#EDE9FE' },
  { name: 'blue', color: '#3B82F6', light: '#DBEAFE' },
  { name: 'cyan', color: '#06B6D4', light: '#CFFAFE' },
  { name: 'green', color: '#22C55E', light: '#DCFCE7' },
  { name: 'yellow', color: '#EAB308', light: '#FEF9C3' },
  { name: 'orange', color: '#F97316', light: '#FFEDD5' },
  { name: 'red', color: '#EF4444', light: '#FEE2E2' },
  { name: 'pink', color: '#EC4899', light: '#FCE7F3' },
  { name: 'grey', color: '#6B7280', light: '#F3F4F6' },
];

class WorkspaceService {
  constructor() {
    this._order = [];        // workspace ID order (from ws_meta)
    this._items = {};        // workspace items keyed by ID
    this._localState = null; // { activeWorkspaceId, rootFolderIds }
    this._arcSpacesRootId = null;
    // Delay before first-run setup writes — gives Chrome sync time to propagate.
    // Can be set to 0 in tests.
    this._firstRunDelayMs = 2000;
    // Reinstall prompt: set when sync data exists but local state is missing
    this.needsReinstallPrompt = false;
    this._reinstallMeta = null;
  }

  get colors() {
    return WORKSPACE_COLORS;
  }

  // ── Persistence Helpers ───────────────────────────────

  /**
   * Save a single workspace item to sync (strips device-local fields).
   * Always saves a shallow copy to avoid mock storage keeping a reference.
   */
  async _saveItem(wsId) {
    const item = { ...this._items[wsId] };
    delete item.rootFolderId;       // device-local bookmark ID
    delete item.pinnedBookmarkIds;  // redundant with pinnedBookmarks
    await storageService.saveWorkspaceItem(wsId, item);
  }

  /**
   * Prepare a clean copy of workspace data for sync storage.
   * Strips device-local fields and returns a new object.
   */
  _syncableItem(data) {
    const item = { ...data };
    delete item.rootFolderId;
    delete item.pinnedBookmarkIds;
    return item;
  }

  /**
   * Merge two workspace order arrays, preserving all unique IDs.
   * Keeps the order of `primary` and appends any IDs from `secondary`
   * that aren't already present.
   * @param {string[]} primary
   * @param {string[]} secondary
   * @returns {string[]}
   */
  _mergeOrders(primary, secondary) {
    const seen = new Set(primary);
    const merged = [...primary];
    for (const id of secondary) {
      if (!seen.has(id)) {
        seen.add(id);
        merged.push(id);
      }
    }
    return merged;
  }

  /**
   * Save workspace metadata (order + version) to sync.
   * By default, merges with remote ws_meta to avoid dropping workspaces
   * that another device added (Chrome sync is last-write-wins).
   * Pass { skipMerge: true } when intentionally removing workspaces (delete, validate).
   */
  async _saveMeta({ skipMerge = false } = {}) {
    if (!skipMerge) {
      const remote = await storageService.getWorkspaceMeta();
      if (remote && remote.order) {
        this._order = this._mergeOrders(this._order, remote.order);
      }
    }
    await storageService.saveWorkspaceMeta({ order: [...this._order], version: 2 });
  }

  /**
   * Save device-local workspace state.
   */
  async _saveLocal() {
    await storageService.saveWorkspaceLocal(this._localState);
  }

  // ── Init / Load ───────────────────────────────────────

  /**
   * Initialize — load workspaces from storage.
   * If none exist, runs first-time setup.
   * Retries up to 3 times with backoff on failure.
   */
  async init() {
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 500;

    // Reset reinstall prompt state (may be stale from a previous init call)
    this.needsReinstallPrompt = false;
    this._reinstallMeta = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Debug: log sync state for troubleshooting cross-device sync
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id) {
          console.log('Arc Spaces init: extension ID =', chrome.runtime.id);
        }

        // 1. Try v2 format first (split keys)
        const meta = await storageService.getWorkspaceMeta();
        console.log('Arc Spaces init: ws_meta =', JSON.stringify(meta));
        if (meta && meta.version === 2) {
          // Check for reinstall/new-device: sync data exists but local state is missing
          const localCheck = await storageService.getWorkspaceLocal();
          const isReinstall = (!localCheck.activeWorkspaceId &&
                               Object.keys(localCheck.rootFolderIds || {}).length === 0);

          if (isReinstall) {
            // Load workspaces so we can show names in the prompt
            await this._loadV2(meta);
            this._reinstallMeta = meta;
            this.needsReinstallPrompt = true;
            console.log('Arc Spaces: reinstall detected, prompting user');
            return;
          }

          console.log('Arc Spaces init: loading v2 format, workspaces:', meta.order);
          await this._loadV2(meta);
        } else {
          // 2. Check for v1 format (single "workspaces" key) and migrate
          const oldData = await storageService.getWorkspaces();
          if (oldData) {
            console.log('Arc Spaces init: migrating v1 format');
            await this._migrateV1toV2(oldData);
          } else {
            // 3. No data at all — first-run setup
            console.log('Arc Spaces init: no sync data found, running first-run setup');
            await this._firstRunSetup();

            // _firstRunSetup may have detected surviving bookmark folders
            // and set the reinstall prompt flag — return early like the
            // sync-based reinstall detection above.
            if (this.needsReinstallPrompt) {
              console.log('Arc Spaces: bookmark-based reinstall detected, prompting user');
              return;
            }
          }
        }

        await this._completeInit();
        return;
      } catch (err) {
        console.warn(`Arc Spaces init attempt ${attempt}/${MAX_RETRIES} failed:`, err);
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Complete initialization: load local state, reconcile folders, validate.
   * Shared by init(), continueInit(), and resetAndSetup().
   */
  async _completeInit() {
    // Load device-local state
    this._localState = await storageService.getWorkspaceLocal();
    this._arcSpacesRootId = await storageService.getArcSpacesRootIdLocal();

    // Use local activeWorkspaceId (fallback to first in order)
    if (!this._localState.activeWorkspaceId || !this._items[this._localState.activeWorkspaceId]) {
      this._localState.activeWorkspaceId = this._order[0] || null;
    }

    // Attach rootFolderIds from local state to in-memory items
    for (const wsId of this._order) {
      if (this._items[wsId] && this._localState.rootFolderIds[wsId]) {
        this._items[wsId].rootFolderId = this._localState.rootFolderIds[wsId];
      }
    }

    // Reconcile bookmark folder IDs for synced workspaces
    // (folder IDs are local — they differ across devices)
    await this._reconcileFolders();

    // Reconcile pinned bookmark IDs across devices
    await this._reconcilePinnedBookmarks();

    // Validate that workspace folders still exist
    await this._validateFolders();

    console.log('Arc Spaces init complete:', this._order.length, 'workspaces loaded:', this._order);
  }

  /**
   * Continue initialization after reinstall prompt — user chose "Restore".
   * Runs the remaining init steps that were deferred.
   */
  async continueInit() {
    this.needsReinstallPrompt = false;
    this._reinstallMeta = null;
    await this._completeInit();
    // Adopt any bookmark folders not claimed by existing workspaces.
    // Handles reinstall where sync only partially restored (e.g. 1 of 3 workspaces).
    await this._adoptOrphanedBookmarkFolders();
  }

  /**
   * Clear all sync data and run first-time setup from scratch.
   * Called when user chooses "Start Fresh" on reinstall prompt.
   */
  async resetAndSetup() {
    this.needsReinstallPrompt = false;

    // Delete all workspace items and ws_meta from sync
    if (this._reinstallMeta && this._reinstallMeta.order) {
      for (const wsId of this._reinstallMeta.order) {
        await storageService.deleteWorkspaceItem(wsId);
      }
    }
    try {
      await chrome.storage.sync.remove('ws_meta');
    } catch { /* ignore */ }

    this._reinstallMeta = null;
    this._order = [];
    this._items = {};
    this._localState = null;
    this._arcSpacesRootId = null;

    // Run first-time setup (creates default workspace).
    // Skip bookmark recovery — user explicitly chose "Start Fresh".
    await this._firstRunSetup({ skipBookmarkRecovery: true });

    // Complete the remaining init steps
    await this._completeInit();
  }

  /**
   * Load v2 split-key format.
   * Also discovers orphaned ws_* keys not in meta.order (e.g. after another
   * device's _firstRunSetup overwrote ws_meta) and recovers them.
   */
  async _loadV2(meta) {
    this._order = meta.order || [];
    this._items = await storageService.getAllWorkspaceItems(this._order);

    // Discover orphaned workspace keys not referenced by ws_meta
    const allKeys = await storageService.discoverAllWorkspaceKeys();
    const orphaned = allKeys.filter(k => !this._order.includes(k));
    if (orphaned.length > 0) {
      console.log('Arc Spaces: recovering orphaned workspaces:', orphaned);
      const orphanItems = await storageService.getAllWorkspaceItems(orphaned);
      Object.assign(this._items, orphanItems);
      this._order = this._mergeOrders(this._order, Object.keys(orphanItems));
      // Persist the recovered ws_meta so future loads include these workspaces
      await this._saveMeta();
    }
  }

  /**
   * Migrate from v1 (single "workspaces" key) to v2 (split keys).
   */
  async _migrateV1toV2(oldData) {
    this._order = oldData.order || [];
    this._items = {};
    const rootFolderIds = {};

    for (const wsId of this._order) {
      const ws = oldData.items[wsId];
      if (!ws) continue;
      // Extract device-local rootFolderId
      rootFolderIds[wsId] = ws.rootFolderId;
      // Copy workspace data (keep rootFolderId in memory, strip for sync)
      this._items[wsId] = { ...ws };
      // Save individual workspace to sync (strips local-only fields)
      await storageService.saveWorkspaceItem(wsId, this._syncableItem(this._items[wsId]));
      // Remove local-only fields from in-memory copy (will be re-attached from localState)
      delete this._items[wsId].rootFolderId;
      delete this._items[wsId].pinnedBookmarkIds;
    }

    // Save metadata
    await storageService.saveWorkspaceMeta({ order: this._order, version: 2 });

    // Save local state
    this._localState = {
      activeWorkspaceId: oldData.activeWorkspaceId || this._order[0],
      rootFolderIds,
    };
    await storageService.saveWorkspaceLocal(this._localState);

    // Delete old v1 key
    await storageService.deleteOldWorkspacesKey();
  }

  /**
   * Dynamically find the "Other Bookmarks" folder ID.
   * Chrome's root has children: Bookmarks Bar, Other Bookmarks, Mobile Bookmarks.
   * The IDs are NOT guaranteed to be '1', '2', '3' across installations/locales.
   * @returns {Promise<string>}
   */
  async _getOtherBookmarksId() {
    const tree = await bookmarkService.getTree();
    if (!tree || tree.length === 0) {
      throw new Error('Bookmark tree is empty — Chrome may still be starting');
    }
    const root = tree[0];
    if (!root || !root.children || root.children.length === 0) {
      throw new Error('Bookmark root has no children — unexpected browser state');
    }

    // Try to find "Other Bookmarks" / "Other bookmarks" by title
    const otherBookmarks = root.children.find(child =>
      child.title.toLowerCase() === 'other bookmarks'
    );
    if (otherBookmarks) return otherBookmarks.id;

    // Fallback: Chrome convention is that "Other Bookmarks" is the second child
    if (root.children.length >= 2) {
      return root.children[1].id;
    }

    // Ultimate fallback: first child
    return root.children[0].id;
  }

  /**
   * Rebuild workspace data from surviving bookmark folders after reinstall.
   * Called when all sync data is gone (Chrome deletes it on uninstall) but
   * the "Arc Spaces" bookmark folder tree still exists with user data.
   * Creates a workspace for each subfolder, writes sync + local state.
   * @param {string} rootId - The "Arc Spaces" root bookmark folder ID
   * @param {Array} subfolders - Subfolder bookmark nodes under the root
   */
  async _rebuildFromBookmarkFolders(rootId, subfolders) {
    this._order = [];
    this._items = {};
    const rootFolderIds = {};

    for (let i = 0; i < subfolders.length; i++) {
      const folder = subfolders[i];
      const wsId = i === 0 ? 'ws_default' : `ws_${Date.now().toString(36)}_${i}`;
      const colorInfo = WORKSPACE_COLORS[i % WORKSPACE_COLORS.length];

      // Extract emoji from folder title prefix (e.g. "🏠 Personal" → emoji: "🏠", name: "Personal")
      const { emoji, name } = extractEmojiPrefix(folder.title);

      // Restore shortcuts from __shortcuts__ bookmark folder if present
      const shortcuts = await this._loadShortcutsFromBookmarks(folder.id);

      const workspace = {
        id: wsId,
        name,
        emoji,
        icon: i === 0 ? 'home' : 'folder',
        color: colorInfo.color,
        colorScheme: colorInfo.name,
        pinnedBookmarks: [],
        shortcuts,
        created: Date.now(),
      };

      this._order.push(wsId);
      this._items[wsId] = { ...workspace, rootFolderId: folder.id };
      rootFolderIds[wsId] = folder.id;

      // Save workspace item to sync
      await storageService.saveWorkspaceItem(wsId, this._syncableItem(workspace));
    }

    // Save meta
    await storageService.saveWorkspaceMeta({ order: [...this._order], version: 2 });

    // Save local state
    this._localState = {
      activeWorkspaceId: this._order[0],
      rootFolderIds,
    };
    await storageService.saveWorkspaceLocal(this._localState);
    this._arcSpacesRootId = rootId;
    await storageService.saveArcSpacesRootIdLocal(rootId);
  }

  /**
   * First-run: create the Arc Spaces folder and default workspace.
   * Includes a safety re-check to avoid overwriting synced data from another device
   * (sync data may arrive slightly after the first read).
   *
   * On a new device where sync data may still be propagating, we delay the sync
   * write briefly so incoming data from another device can arrive first.
   *
   * @param {Object} [options]
   * @param {boolean} [options.skipBookmarkRecovery=false] - Skip bookmark-based
   *   reinstall detection (used by resetAndSetup to avoid infinite loop).
   */
  async _firstRunSetup({ skipBookmarkRecovery = false } = {}) {
    // Safety re-check: v2 data may have arrived since our first read
    const freshMeta = await storageService.getWorkspaceMeta();
    if (freshMeta && freshMeta.version === 2) {
      await this._loadV2(freshMeta);
      return;
    }
    // Also check v1 format
    const freshV1 = await storageService.getWorkspaces();
    if (freshV1) {
      await this._migrateV1toV2(freshV1);
      return;
    }

    // Wait briefly for sync data to arrive from another device.
    // Chrome sync can take seconds to propagate after extension install.
    if (this._firstRunDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this._firstRunDelayMs));
    }

    // Re-check after waiting — sync data may have arrived
    const delayedMeta = await storageService.getWorkspaceMeta();
    if (delayedMeta && delayedMeta.version === 2) {
      await this._loadV2(delayedMeta);
      return;
    }
    const delayedV1 = await storageService.getWorkspaces();
    if (delayedV1) {
      await this._migrateV1toV2(delayedV1);
      return;
    }

    // Orphan recovery: even without ws_meta, individual ws_* keys may exist
    // (e.g. ws_meta was lost but workspace data survived in sync).
    const orphanedKeys = await storageService.discoverAllWorkspaceKeys();
    if (orphanedKeys.length > 0) {
      console.log('Arc Spaces init: discovered orphaned workspace keys:', orphanedKeys);
      // Put ws_default first if present, then the rest
      const recoveredOrder = orphanedKeys.includes('ws_default')
        ? ['ws_default', ...orphanedKeys.filter(k => k !== 'ws_default')]
        : orphanedKeys;
      const recoveredMeta = { order: recoveredOrder, version: 2 };
      await storageService.saveWorkspaceMeta(recoveredMeta);
      await this._loadV2(recoveredMeta);
      return;
    }

    // ── Bookmark-based reinstall detection ──
    // All sync data is gone (Chrome deletes it on uninstall), but the
    // bookmark folders under "Arc Spaces" survive because they're regular
    // Chrome bookmarks. Detect them and offer to rebuild workspaces.
    if (!skipBookmarkRecovery) {
      const bestRootId = await this._findBestArcSpacesRoot();
      if (bestRootId) {
        const rootChildren = await bookmarkService.getChildren(bestRootId);
        const subfolders = rootChildren.filter(c => !c.url);

        if (subfolders.length > 0) {
          // Check for meaningful content: >1 subfolder, or 1 subfolder with bookmarks
          let hasContent = subfolders.length > 1;
          if (!hasContent && subfolders.length === 1) {
            const children = await bookmarkService.getChildren(subfolders[0].id);
            hasContent = children.length > 0;
          }

          if (hasContent) {
            console.log('Arc Spaces: bookmark folders survived reinstall, rebuilding',
              subfolders.map(f => f.title));
            await this._rebuildFromBookmarkFolders(bestRootId, subfolders);
            this._reinstallMeta = { order: [...this._order], version: 2 };
            this.needsReinstallPrompt = true;
            return;
          }
        }
      }
    }

    // arcSpacesRootId from local storage
    let rootId = await storageService.getArcSpacesRootIdLocal();

    if (!rootId) {
      // Check if "Arc Spaces" folder already exists (from a previous install)
      const bestRootId = await this._findBestArcSpacesRoot();
      if (bestRootId) {
        rootId = bestRootId;
      } else {
        // Dynamically find "Other Bookmarks" instead of hardcoding id '2'
        const otherBookmarksId = await this._getOtherBookmarksId();
        const folder = await bookmarkService.create({
          parentId: otherBookmarksId,
          title: 'Arc Spaces'
        });
        rootId = folder.id;
      }
      this._arcSpacesRootId = rootId;
      // Save to LOCAL storage (not sync) — this is a device-local bookmark ID
      await storageService.saveArcSpacesRootIdLocal(rootId);
    } else {
      this._arcSpacesRootId = rootId;
    }

    // Check if a "Personal" subfolder already exists under Arc Spaces
    const children = await bookmarkService.getChildren(rootId);
    const existingPersonal = children.find(c => !c.url && c.title === 'Personal');

    let personalFolderId;
    if (existingPersonal) {
      personalFolderId = existingPersonal.id;
    } else {
      const personalFolder = await bookmarkService.create({
        parentId: rootId,
        title: 'Personal'
      });
      personalFolderId = personalFolder.id;
    }

    // Set up v2 format
    const wsId = 'ws_default';
    this._order = [wsId];
    this._items = {
      [wsId]: {
        id: wsId,
        name: 'Personal',
        emoji: '',
        icon: 'home',
        color: '#7C5CFC',
        colorScheme: 'purple',
        pinnedBookmarks: [],
        shortcuts: [],
        created: Date.now()
      }
    };

    // Save to sync as split keys (clone to avoid reference issues)
    await storageService.saveWorkspaceItem(wsId, this._syncableItem(this._items[wsId]));
    // Safety merge: re-read ws_meta in case another device wrote it between
    // our last check and now, so we never drop workspaces.
    const raceMeta = await storageService.getWorkspaceMeta();
    if (raceMeta && raceMeta.version === 2) {
      this._order = this._mergeOrders(raceMeta.order, this._order);
    }
    await storageService.saveWorkspaceMeta({ order: [...this._order], version: 2 });

    // Save local state
    this._localState = {
      activeWorkspaceId: wsId,
      rootFolderIds: { [wsId]: personalFolderId },
    };
    await storageService.saveWorkspaceLocal(this._localState);

    // Initialize local storage defaults
    await storageService.setLocal({
      onboardingDismissed: false,
      uiState: { expandedFolders: {}, scrollPositions: {} }
    });
  }

  // ── Validation & Reconciliation ───────────────────────

  /**
   * Validate that workspace root folders still exist.
   * Remove workspaces with stale folder references.
   */
  async _validateFolders() {
    if (!this._order || this._order.length === 0) return;

    let changed = false;
    const deletedIds = [];

    for (const id of [...this._order]) {
      const ws = this._items[id];
      if (!ws) {
        // Stale ID in order array with no matching item — clean it up
        this._order = this._order.filter(wid => wid !== id);
        changed = true;
        continue;
      }
      // Skip validation if rootFolderId was never assigned
      // (e.g., synced workspace on a device where _reconcileFolders hasn't run yet)
      if (!ws.rootFolderId) continue;
      const folder = await bookmarkService.get(ws.rootFolderId);
      if (!folder) {
        delete this._items[id];
        deletedIds.push(id);
        this._order = this._order.filter(wid => wid !== id);
        // Remove from local rootFolderIds
        if (this._localState && this._localState.rootFolderIds) {
          delete this._localState.rootFolderIds[id];
        }
        changed = true;
      }
    }

    if (changed) {
      if (this._order.length === 0) {
        // All workspaces had stale folders — re-run first-time setup
        try {
          await this._firstRunSetup();
        } catch (setupErr) {
          console.warn('Arc Spaces: _firstRunSetup during validation failed:', setupErr);
          throw setupErr; // Let init() retry loop handle this
        }
      } else {
        if (!this._items[this._localState.activeWorkspaceId]) {
          this._localState.activeWorkspaceId = this._order[0];
        }
        // Save updated meta + local (skipMerge: intentionally removing stale workspaces)
        await this._saveMeta({ skipMerge: true });
        await this._saveLocal();
        // Delete removed workspace items from sync
        for (const id of deletedIds) {
          await storageService.deleteWorkspaceItem(id);
        }
      }
    }
  }

  /**
   * Find the best "Arc Spaces" root folder among potentially multiple matches.
   * Prefers the one with the most subfolder children (most likely to have user data).
   * When multiple candidates tie, prefers one whose children match synced workspace names.
   * @returns {Promise<string|null>} The bookmark ID of the best root, or null if none found.
   */
  async _findBestArcSpacesRoot() {
    const existing = await bookmarkService.search('Arc Spaces');
    const candidates = existing.filter(b => !b.url && b.title === 'Arc Spaces');

    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].id;

    // Multiple "Arc Spaces" folders — pick the one with the most folder children
    const wsNames = new Set(this._order.map(id => this._items[id]?.name).filter(Boolean));
    let bestId = candidates[0].id;
    let bestScore = -1;

    for (const candidate of candidates) {
      const children = await bookmarkService.getChildren(candidate.id);
      const folderChildren = children.filter(c => !c.url);
      // Primary score: number of folder children
      let score = folderChildren.length * 1000;
      // Tiebreaker: how many folder names match synced workspace names
      score += folderChildren.filter(c => wsNames.has(c.title)).length;

      if (score > bestScore) {
        bestScore = score;
        bestId = candidate.id;
      }
    }

    return bestId;
  }

  /**
   * Reconcile synced workspace configs with local bookmark folders.
   * Workspace configs sync via chrome.storage.sync, but rootFolderId values
   * are LOCAL bookmark IDs that don't exist on other devices.
   * Uses two-pass matching: first by name, then positional fallback for
   * renamed workspaces. Only creates new folders as a last resort.
   */
  async _reconcileFolders() {
    if (!this._order || this._order.length === 0) return;

    // Ensure the Arc Spaces root folder exists locally.
    // On a new device, _arcSpacesRootId will be null (no local storage yet).
    // We must find or create the root folder before we can reconcile workspace folders.
    if (!this._arcSpacesRootId) {
      // New device: find existing "Arc Spaces" folder or create one
      const bestRootId = await this._findBestArcSpacesRoot();
      if (bestRootId) {
        this._arcSpacesRootId = bestRootId;
      } else {
        const otherBookmarksId = await this._getOtherBookmarksId();
        const folder = await bookmarkService.create({
          parentId: otherBookmarksId,
          title: 'Arc Spaces'
        });
        this._arcSpacesRootId = folder.id;
      }
      await storageService.saveArcSpacesRootIdLocal(this._arcSpacesRootId);
    } else {
      // Have a cached root ID — verify the folder still exists
      const rootFolder = await bookmarkService.get(this._arcSpacesRootId);
      if (!rootFolder) {
        // Root folder was deleted — find or re-create it
        const bestRootId = await this._findBestArcSpacesRoot();
        if (bestRootId) {
          this._arcSpacesRootId = bestRootId;
        } else {
          const otherBookmarksId = await this._getOtherBookmarksId();
          const folder = await bookmarkService.create({
            parentId: otherBookmarksId,
            title: 'Arc Spaces'
          });
          this._arcSpacesRootId = folder.id;
        }
        await storageService.saveArcSpacesRootIdLocal(this._arcSpacesRootId);
      }
    }

    const localChildren = await bookmarkService.getChildren(this._arcSpacesRootId);
    const localFolders = localChildren.filter(c => !c.url);
    let changed = false;

    if (!this._localState) {
      this._localState = { activeWorkspaceId: this._order[0], rootFolderIds: {} };
    }

    // Track which local folders have been claimed and which workspaces need a folder
    const claimedFolderIds = new Set();
    const unmatchedWorkspaceIds = [];

    // ── Pass 1: Match by name ──────────────────────────
    for (const id of this._order) {
      const ws = this._items[id];
      if (!ws) continue;

      // Check if current rootFolderId is still valid
      if (ws.rootFolderId) {
        const existing = await bookmarkService.get(ws.rootFolderId);
        if (existing) {
          claimedFolderIds.add(ws.rootFolderId);
          continue; // Folder exists, no reconciliation needed
        }
      }

      // Try to find a matching local folder by name (skip already-claimed folders)
      // Match against both emoji-prefixed title and plain name
      const expectedTitle = buildFolderTitle(ws.name, ws.emoji || '');
      const match = localFolders.find(c => !claimedFolderIds.has(c.id) &&
        (c.title === expectedTitle || c.title === ws.name || extractEmojiPrefix(c.title).name === ws.name)
      );
      if (match) {
        ws.rootFolderId = match.id;
        this._localState.rootFolderIds[id] = match.id;
        claimedFolderIds.add(match.id);
        changed = true;
      } else {
        unmatchedWorkspaceIds.push(id);
      }
    }

    // ── Pass 2: Match remaining workspaces to remaining folders by position ──
    const unclaimedFolders = localFolders.filter(c => !claimedFolderIds.has(c.id));

    for (let i = 0; i < unmatchedWorkspaceIds.length; i++) {
      const wsId = unmatchedWorkspaceIds[i];
      const ws = this._items[wsId];
      if (!ws) continue;

      if (i < unclaimedFolders.length) {
        // Use an unclaimed existing folder (positional fallback).
        // This handles renamed workspaces: the folder still exists
        // under the old name but the sync data has the new name.
        const folder = unclaimedFolders[i];
        ws.rootFolderId = folder.id;
        this._localState.rootFolderIds[wsId] = folder.id;
        claimedFolderIds.add(folder.id);
        changed = true;
        // Rename the bookmark folder to match the synced workspace name (with emoji prefix)
        try {
          await bookmarkService.update(folder.id, { title: buildFolderTitle(ws.name, ws.emoji || '') });
        } catch { /* folder rename is best-effort */ }
      } else {
        // No unclaimed folders left — create a new one
        const newFolder = await bookmarkService.create({
          parentId: this._arcSpacesRootId,
          title: buildFolderTitle(ws.name, ws.emoji || '')
        });
        ws.rootFolderId = newFolder.id;
        this._localState.rootFolderIds[wsId] = newFolder.id;
        changed = true;
      }
    }

    if (changed) {
      await this._saveLocal();
    }
  }

  /**
   * Scan the Arc Spaces bookmark folder and adopt any subfolder that
   * doesn't already have a matching workspace. This handles the reinstall
   * scenario where sync partially restores (e.g. 1 of 3 workspaces) but
   * all bookmark folders survive intact.
   * @returns {Promise<number>} Number of adopted folders
   */
  async _adoptOrphanedBookmarkFolders() {
    // Find Arc Spaces root
    let rootId = this._arcSpacesRootId;
    if (!rootId) {
      rootId = await this._findBestArcSpacesRoot();
      if (!rootId) return 0;
    }

    const children = await bookmarkService.getChildren(rootId);
    const subfolders = children.filter(c => !c.url);
    if (subfolders.length === 0) return 0;

    // Build set of already-claimed folder IDs
    const claimedIds = new Set();
    for (const wsId of this._order) {
      const ws = this._items[wsId];
      if (ws && ws.rootFolderId) {
        claimedIds.add(ws.rootFolderId);
      }
    }

    // Find unclaimed subfolders
    const unclaimed = subfolders.filter(f => !claimedIds.has(f.id));
    if (unclaimed.length === 0) return 0;

    // Adopt each unclaimed folder as a new workspace
    const colorOffset = this._order.length;
    for (let i = 0; i < unclaimed.length; i++) {
      const folder = unclaimed[i];
      const wsId = `ws_${Date.now().toString(36)}_${i}`;
      const colorInfo = WORKSPACE_COLORS[(colorOffset + i) % WORKSPACE_COLORS.length];

      // Extract emoji from folder title prefix (e.g. "🏠 Work" → emoji: "🏠", name: "Work")
      const { emoji, name } = extractEmojiPrefix(folder.title);

      // Restore shortcuts from __shortcuts__ bookmark folder if present
      const shortcuts = await this._loadShortcutsFromBookmarks(folder.id);

      const workspace = {
        id: wsId,
        name,
        emoji,
        icon: 'folder',
        color: colorInfo.color,
        colorScheme: colorInfo.name,
        pinnedBookmarks: [],
        shortcuts,
        created: Date.now(),
      };

      this._items[wsId] = { ...workspace, rootFolderId: folder.id };
      this._order.push(wsId);
      this._localState.rootFolderIds[wsId] = folder.id;

      // Save to sync
      await storageService.saveWorkspaceItem(wsId, this._syncableItem(workspace));
    }

    // Persist updated meta + local
    await this._saveMeta();
    await this._saveLocal();

    console.log(`Arc Spaces: adopted ${unclaimed.length} orphaned bookmark folder(s):`,
      unclaimed.map(f => f.title));
    return unclaimed.length;
  }

  /**
   * Get folder names from the Arc Spaces bookmark tree.
   * Used by the reinstall prompt to show all discovered workspace names
   * (not just the ones from partial sync data).
   * @returns {Promise<string[]>}
   */
  async getBookmarkFolderNames() {
    const rootId = await this._findBestArcSpacesRoot();
    if (!rootId) return [];
    const children = await bookmarkService.getChildren(rootId);
    return children.filter(c => !c.url).map(c => c.title);
  }

  // ── Shortcut Bookmark Persistence ─────────────────

  /**
   * Sync a workspace's shortcuts array to a __shortcuts__ bookmark folder.
   * One-way sync: shortcuts array → bookmark folder.
   * Creates the folder lazily on first shortcut.
   * @param {string} wsId
   */
  async _syncShortcutsToBookmarks(wsId) {
    const ws = this._items[wsId];
    if (!ws || !ws.rootFolderId) return;

    const shortcuts = ws.shortcuts || [];

    // Find or create __shortcuts__ folder
    const children = await bookmarkService.getChildren(ws.rootFolderId);
    let folder = children.find(c => !c.url && c.title === SHORTCUTS_FOLDER_NAME);

    if (shortcuts.length === 0) {
      // No shortcuts — remove the folder if it exists
      if (folder) {
        try { await bookmarkService.removeTree(folder.id); } catch { /* already gone */ }
      }
      return;
    }

    if (!folder) {
      folder = await bookmarkService.create({
        parentId: ws.rootFolderId,
        title: SHORTCUTS_FOLDER_NAME,
      });
    }

    // Get current bookmark children
    const existing = await bookmarkService.getChildren(folder.id);
    const existingByUrl = new Map(existing.filter(b => b.url).map(b => [b.url, b]));
    const wantedUrls = new Set(shortcuts.map(s => s.url));

    // Remove bookmarks that are no longer in shortcuts
    for (const [url, bm] of existingByUrl) {
      if (!wantedUrls.has(url)) {
        try { await bookmarkService.remove(bm.id); } catch { /* ok */ }
      }
    }

    // Add missing shortcuts as bookmarks
    for (const shortcut of shortcuts) {
      if (!existingByUrl.has(shortcut.url)) {
        await bookmarkService.create({
          parentId: folder.id,
          title: shortcut.title || '',
          url: shortcut.url,
        });
      }
    }
  }

  /**
   * Load shortcuts from the __shortcuts__ bookmark folder.
   * Used during reinstall recovery to restore shortcuts from surviving bookmarks.
   * @param {string} rootFolderId - The workspace's bookmark folder ID
   * @returns {Promise<Array<{url: string, title: string}>>}
   */
  async _loadShortcutsFromBookmarks(rootFolderId) {
    try {
      const children = await bookmarkService.getChildren(rootFolderId);
      const folder = children.find(c => !c.url && c.title === SHORTCUTS_FOLDER_NAME);
      if (!folder) return [];

      const bookmarks = await bookmarkService.getChildren(folder.id);
      return bookmarks
        .filter(b => b.url)
        .map(b => ({ url: b.url, title: b.title || '' }));
    } catch {
      return [];
    }
  }

  // ── Public Getters ────────────────────────────────────

  getAll() {
    return this._order.map(id => this._items[id]).filter(Boolean);
  }

  getActive() {
    if (!this._localState || !this._localState.activeWorkspaceId) return null;
    return this._items[this._localState.activeWorkspaceId] || null;
  }

  getById(id) {
    return this._items[id] || null;
  }

  // ── Workspace CRUD ────────────────────────────────────

  async switchTo(workspaceId) {
    if (!this._items[workspaceId]) return;
    this._localState.activeWorkspaceId = workspaceId;
    // Only save to LOCAL — switching is device-specific, no sync write
    await this._saveLocal();
    bus.emit(Events.WORKSPACE_CHANGED, this.getActive());
  }

  async create(name, colorScheme = 'blue') {
    const colorInfo = WORKSPACE_COLORS.find(c => c.name === colorScheme) || WORKSPACE_COLORS[1];
    const id = 'ws_' + Date.now().toString(36);

    // Ensure Arc Spaces root folder exists before creating a workspace folder
    if (!this._arcSpacesRootId) {
      await this._reconcileFolders();
    }
    if (!this._arcSpacesRootId) {
      throw new Error('Cannot create workspace: Arc Spaces root folder not found');
    }

    const folder = await bookmarkService.create({
      parentId: this._arcSpacesRootId,
      title: name
    });

    const workspace = {
      id,
      name,
      emoji: '',
      icon: 'folder',
      color: colorInfo.color,
      colorScheme: colorInfo.name,
      pinnedBookmarks: [],
      shortcuts: [],
      created: Date.now()
    };

    this._items[id] = { ...workspace, rootFolderId: folder.id };
    this._order.push(id);
    this._localState.rootFolderIds[id] = folder.id;

    // Save individual item + meta to sync, local state to local
    await this._saveItem(id);
    await this._saveMeta();
    await this._saveLocal();

    bus.emit(Events.WORKSPACE_CREATED, this._items[id]);
    return this._items[id];
  }

  async rename(workspaceId, newName) {
    const ws = this._items[workspaceId];
    if (!ws) return;
    ws.name = newName;
    // Include emoji prefix in bookmark folder title so it survives reinstall
    const folderTitle = buildFolderTitle(newName, ws.emoji || '');
    await bookmarkService.update(ws.rootFolderId, { title: folderTitle });
    await this._saveItem(workspaceId);
    bus.emit(Events.WORKSPACE_RENAMED, ws);
  }

  async changeColor(workspaceId, colorScheme) {
    const ws = this._items[workspaceId];
    if (!ws) return;
    const colorInfo = WORKSPACE_COLORS.find(c => c.name === colorScheme);
    if (!colorInfo) return;
    ws.color = colorInfo.color;
    ws.colorScheme = colorInfo.name;
    await this._saveItem(workspaceId);
    if (workspaceId === this._localState.activeWorkspaceId) {
      bus.emit(Events.THEME_CHANGED, ws);
    }
  }

  /**
   * Reorder workspaces.
   * @param {string[]} newOrder - Array of workspace IDs in the desired order.
   *   Must contain exactly the same IDs as this._order (no additions/removals).
   */
  async reorder(newOrder) {
    // Validate: must be same set of IDs
    if (newOrder.length !== this._order.length) return;
    const currentSet = new Set(this._order);
    if (!newOrder.every(id => currentSet.has(id))) return;

    this._order = [...newOrder];
    await this._saveMeta();
    bus.emit(Events.WORKSPACE_REORDERED, { order: this._order });
  }

  /**
   * Set or clear an emoji icon for a workspace.
   * Persists to sync and encodes the emoji as a prefix on the bookmark
   * folder title so it survives extension reinstall.
   * @param {string} workspaceId
   * @param {string} emoji - A single emoji character, or '' to clear.
   */
  async setEmoji(workspaceId, emoji) {
    const ws = this._items[workspaceId];
    if (!ws) return;

    const clean = (emoji || '').trim();
    ws.emoji = clean;

    // Update bookmark folder title to include/exclude emoji prefix
    if (ws.rootFolderId) {
      const newTitle = buildFolderTitle(ws.name, clean);
      try {
        await bookmarkService.update(ws.rootFolderId, { title: newTitle });
      } catch { /* best-effort */ }
    }

    await this._saveItem(workspaceId);
    bus.emit(Events.WORKSPACE_RENAMED, ws);
  }

  async delete(workspaceId) {
    if (this._order.length <= 1) return;
    const ws = this._items[workspaceId];
    if (!ws) return;
    try { await bookmarkService.removeTree(ws.rootFolderId); } catch { /* already gone */ }
    delete this._items[workspaceId];
    this._order = this._order.filter(id => id !== workspaceId);
    delete this._localState.rootFolderIds[workspaceId];
    if (this._localState.activeWorkspaceId === workspaceId) {
      this._localState.activeWorkspaceId = this._order[0];
    }
    // Delete item from sync, save updated meta + local
    // skipMerge: intentionally removing this workspace — don't re-add from remote
    await storageService.deleteWorkspaceItem(workspaceId);
    await this._saveMeta({ skipMerge: true });
    await this._saveLocal();
    bus.emit(Events.WORKSPACE_DELETED, { id: workspaceId });
    bus.emit(Events.WORKSPACE_CHANGED, this.getActive());
  }

  // ── Pinned Bookmarks ─────────────────────────────────

  async pinBookmark(bookmarkId) {
    const ws = this.getActive();
    if (!ws) return;
    if (!ws.pinnedBookmarks) ws.pinnedBookmarks = [];
    // Also maintain pinnedBookmarkIds for in-memory lookups
    if (!ws.pinnedBookmarkIds) ws.pinnedBookmarkIds = ws.pinnedBookmarks.map(m => m.id);
    if (ws.pinnedBookmarkIds.includes(bookmarkId)) return;

    // Store bookmark metadata for cross-device sync
    const bm = await bookmarkService.get(bookmarkId);
    const meta = { id: bookmarkId };
    if (bm) {
      if (bm.url) meta.url = bm.url;
      meta.title = bm.title;
    }

    ws.pinnedBookmarkIds.push(bookmarkId);
    ws.pinnedBookmarks.push(meta);

    await this._saveItem(ws.id);
    bus.emit(Events.BOOKMARK_PINNED, { bookmarkId, workspaceId: ws.id });
  }

  async unpinBookmark(bookmarkId) {
    const ws = this.getActive();
    if (!ws) return;
    if (!ws.pinnedBookmarkIds) ws.pinnedBookmarkIds = (ws.pinnedBookmarks || []).map(m => m.id);
    ws.pinnedBookmarkIds = ws.pinnedBookmarkIds.filter(id => id !== bookmarkId);
    if (ws.pinnedBookmarks) {
      ws.pinnedBookmarks = ws.pinnedBookmarks.filter(m => m.id !== bookmarkId);
    }
    await this._saveItem(ws.id);
    bus.emit(Events.BOOKMARK_UNPINNED, { bookmarkId, workspaceId: ws.id });
  }

  isPinned(bookmarkId) {
    const ws = this.getActive();
    if (!ws) return false;
    if (!ws.pinnedBookmarkIds) ws.pinnedBookmarkIds = (ws.pinnedBookmarks || []).map(m => m.id);
    return ws.pinnedBookmarkIds.includes(bookmarkId);
  }

  // ── Website Shortcuts ──────────────────────────────

  /**
   * Get shortcuts for the active workspace.
   * @returns {Array<{url: string, title: string}>}
   */
  getShortcuts() {
    const ws = this.getActive();
    return ws && ws.shortcuts ? ws.shortcuts : [];
  }

  /**
   * Add a website shortcut to the active workspace.
   * @param {string} url
   * @param {string} title
   */
  async addShortcut(url, title) {
    const ws = this.getActive();
    if (!ws) return;
    if (!ws.shortcuts) ws.shortcuts = [];

    // Don't add duplicates
    if (ws.shortcuts.some(s => s.url === url)) return;

    // Enforce max of 8 shortcuts per workspace
    if (ws.shortcuts.length >= 8) return;

    ws.shortcuts.push({ url, title: title || '' });
    await this._saveItem(ws.id);
    await this._syncShortcutsToBookmarks(ws.id);
    bus.emit(Events.SHORTCUT_ADDED, { url, title, workspaceId: ws.id });
  }

  /**
   * Remove a website shortcut from the active workspace.
   * @param {string} url
   */
  async removeShortcut(url) {
    const ws = this.getActive();
    if (!ws || !ws.shortcuts) return;
    ws.shortcuts = ws.shortcuts.filter(s => s.url !== url);
    await this._saveItem(ws.id);
    await this._syncShortcutsToBookmarks(ws.id);
    bus.emit(Events.SHORTCUT_REMOVED, { url, workspaceId: ws.id });
  }

  // ── Pinned Bookmark Reconciliation ────────────────────

  /**
   * Reconcile synced pinned bookmark IDs with local bookmark IDs.
   * Pinned IDs are local — they differ across devices.
   * Uses the pinnedBookmarks metadata to match by URL or title.
   */
  async _reconcilePinnedBookmarks() {
    if (!this._order || this._order.length === 0) return;
    let anyChanged = false;

    for (const wsId of this._order) {
      const ws = this._items[wsId];
      if (!ws) continue;

      const pinnedMeta = ws.pinnedBookmarks || [];
      // Ensure pinnedBookmarkIds is populated from metadata
      if (!ws.pinnedBookmarkIds) {
        ws.pinnedBookmarkIds = pinnedMeta.map(m => m.id);
      }
      if (pinnedMeta.length === 0 && ws.pinnedBookmarkIds.length === 0) {
        continue;
      }

      // Build local lookup from workspace subtree
      let subtree;
      try {
        subtree = await bookmarkService.getSubTree(ws.rootFolderId);
      } catch {
        continue; // Folder doesn't exist yet — _reconcileFolders will handle it
      }
      if (!subtree || subtree.length === 0) continue;

      const localByUrl = new Map();
      const localFoldersByTitle = new Map();
      const walkTree = (node) => {
        if (node.url) {
          localByUrl.set(node.url, node);
        } else if (node.title && node.id !== ws.rootFolderId) {
          localFoldersByTitle.set(node.title, node);
        }
        if (node.children) node.children.forEach(walkTree);
      };
      walkTree(subtree[0]);

      let wsChanged = false;

      // If we have metadata, use it for reconciliation
      if (pinnedMeta.length > 0) {
        const reconciledIds = [];
        const reconciledMeta = [];

        for (const meta of pinnedMeta) {
          // Check if current ID is still valid locally
          const existing = await bookmarkService.get(meta.id);
          if (existing) {
            reconciledIds.push(meta.id);
            reconciledMeta.push({ id: meta.id, url: existing.url, title: existing.title });
            continue;
          }

          // Stale ID — try to match by URL (bookmarks) or title (folders)
          let matched = null;
          if (meta.url) {
            matched = localByUrl.get(meta.url);
          }
          if (!matched && meta.title && !meta.url) {
            matched = localFoldersByTitle.get(meta.title);
          }

          if (matched) {
            reconciledIds.push(matched.id);
            reconciledMeta.push({ id: matched.id, url: matched.url, title: matched.title });
            wsChanged = true;
          } else {
            // Bookmark doesn't exist locally — drop from pinned list
            wsChanged = true;
          }
        }

        if (wsChanged || reconciledIds.length !== ws.pinnedBookmarkIds.length) {
          ws.pinnedBookmarkIds = reconciledIds;
          ws.pinnedBookmarks = reconciledMeta;
          wsChanged = true;
        }
      } else {
        // No metadata available — just validate existing IDs
        const validIds = [];
        for (const id of ws.pinnedBookmarkIds) {
          const existing = await bookmarkService.get(id);
          if (existing) {
            validIds.push(id);
          } else {
            wsChanged = true;
          }
        }
        if (wsChanged) {
          ws.pinnedBookmarkIds = validIds;
        }
      }

      if (wsChanged) {
        await this._saveItem(wsId);
        anyChanged = true;
      }
    }

    // Also save local state if any rootFolderIds might have changed
    if (anyChanged) {
      await this._saveLocal();
    }
  }
}

export const workspaceService = new WorkspaceService();
