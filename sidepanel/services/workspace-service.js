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
   * Save workspace metadata (order + version) to sync.
   */
  async _saveMeta() {
    await storageService.saveWorkspaceMeta({ order: this._order, version: 2 });
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

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // 1. Try v2 format first (split keys)
        const meta = await storageService.getWorkspaceMeta();
        if (meta && meta.version === 2) {
          await this._loadV2(meta);
        } else {
          // 2. Check for v1 format (single "workspaces" key) and migrate
          const oldData = await storageService.getWorkspaces();
          if (oldData) {
            await this._migrateV1toV2(oldData);
          } else {
            // 3. No data at all — first-run setup
            await this._firstRunSetup();
          }
        }

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
   * Load v2 split-key format.
   */
  async _loadV2(meta) {
    this._order = meta.order || [];
    this._items = await storageService.getAllWorkspaceItems(this._order);
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
   * First-run: create the Arc Spaces folder and default workspace.
   * Includes a safety re-check to avoid overwriting synced data from another device
   * (sync data may arrive slightly after the first read).
   */
  async _firstRunSetup() {
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

    // arcSpacesRootId from local storage
    let rootId = await storageService.getArcSpacesRootIdLocal();

    if (!rootId) {
      // Check if "Arc Spaces" folder already exists (from a previous install)
      const existing = await bookmarkService.search('Arc Spaces');
      const found = existing.find(b => !b.url && b.title === 'Arc Spaces');
      if (found) {
        rootId = found.id;
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
        // Save updated meta + local
        await this._saveMeta();
        await this._saveLocal();
        // Delete removed workspace items from sync
        for (const id of deletedIds) {
          await storageService.deleteWorkspaceItem(id);
        }
      }
    }
  }

  /**
   * Reconcile synced workspace configs with local bookmark folders.
   * Workspace configs sync via chrome.storage.sync, but rootFolderId values
   * are LOCAL bookmark IDs that don't exist on other devices.
   * This method matches folders by name and creates missing ones.
   */
  async _reconcileFolders() {
    if (!this._order || this._order.length === 0 || !this._arcSpacesRootId) return;

    // Ensure the Arc Spaces root folder exists locally
    const rootFolder = await bookmarkService.get(this._arcSpacesRootId);
    if (!rootFolder) {
      // Root doesn't exist locally — find or create it
      const existing = await bookmarkService.search('Arc Spaces');
      const found = existing.find(b => !b.url && b.title === 'Arc Spaces');
      if (found) {
        this._arcSpacesRootId = found.id;
      } else {
        const otherBookmarksId = await this._getOtherBookmarksId();
        const folder = await bookmarkService.create({
          parentId: otherBookmarksId,
          title: 'Arc Spaces'
        });
        this._arcSpacesRootId = folder.id;
      }
      // Save to LOCAL storage (not sync) — this is a device-local bookmark ID
      await storageService.saveArcSpacesRootIdLocal(this._arcSpacesRootId);
    }

    const localChildren = await bookmarkService.getChildren(this._arcSpacesRootId);
    let changed = false;

    if (!this._localState) {
      this._localState = { activeWorkspaceId: this._order[0], rootFolderIds: {} };
    }

    for (const id of this._order) {
      const ws = this._items[id];
      if (!ws) continue;

      // Check if current rootFolderId exists locally
      if (ws.rootFolderId) {
        const existing = await bookmarkService.get(ws.rootFolderId);
        if (existing) continue; // Folder exists, no reconciliation needed
      }

      // Try to find a matching local folder by name
      const match = localChildren.find(c => !c.url && c.title === ws.name);
      if (match) {
        ws.rootFolderId = match.id;
        this._localState.rootFolderIds[id] = match.id;
        changed = true;
      } else {
        // Create the folder locally
        const newFolder = await bookmarkService.create({
          parentId: this._arcSpacesRootId,
          title: ws.name
        });
        ws.rootFolderId = newFolder.id;
        this._localState.rootFolderIds[id] = newFolder.id;
        changed = true;
      }
    }

    if (changed) {
      await this._saveLocal();
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

    const folder = await bookmarkService.create({
      parentId: this._arcSpacesRootId,
      title: name
    });

    const workspace = {
      id,
      name,
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
    await bookmarkService.update(ws.rootFolderId, { title: newName });
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
    await storageService.deleteWorkspaceItem(workspaceId);
    await this._saveMeta();
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
