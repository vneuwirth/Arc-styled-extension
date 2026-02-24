// Backup & Import — export workspace data + bookmark trees to JSON,
// restore from a backup file. Safety net against data loss.

import { storageService } from './storage-service.js';
import { bookmarkService } from './bookmark-service.js';
import { workspaceService } from './workspace-service.js';

class BackupService {

  // ── Export ──────────────────────────────────────────

  /**
   * Create a full backup of all workspace data and bookmark trees.
   * @returns {Promise<Object>} The backup data object
   */
  async createBackup() {
    const meta = await storageService.getWorkspaceMeta();
    if (!meta || !meta.order || meta.order.length === 0) {
      throw new Error('No workspace data found to back up');
    }

    // Read all workspace items from sync (strips device-local fields)
    const allItems = await storageService.getAllWorkspaceItems(meta.order);
    const workspaces = {};
    for (const wsId of meta.order) {
      if (!allItems[wsId]) continue;
      const ws = { ...allItems[wsId] };
      delete ws.rootFolderId;
      delete ws.pinnedBookmarkIds;
      workspaces[wsId] = ws;
    }

    // Capture bookmark tree for each workspace
    const bookmarkTree = {};
    const liveWorkspaces = workspaceService.getAll();
    for (const ws of liveWorkspaces) {
      if (!ws.rootFolderId) {
        bookmarkTree[ws.id] = [];
        continue;
      }
      try {
        const subtree = await bookmarkService.getSubTree(ws.rootFolderId);
        if (subtree && subtree.length > 0 && subtree[0].children) {
          bookmarkTree[ws.id] = this._serializeBookmarkNodes(subtree[0].children);
        } else {
          bookmarkTree[ws.id] = [];
        }
      } catch {
        bookmarkTree[ws.id] = [];
      }
    }

    // Read settings
    const settings = await storageService.getSettings() || {};

    // Get extension version (may not exist in test environment)
    let extensionVersion = 'unknown';
    try {
      extensionVersion = chrome.runtime.getManifest().version;
    } catch { /* test environment */ }

    return {
      formatVersion: 1,
      extensionVersion,
      createdAt: new Date().toISOString(),
      createdAtMs: Date.now(),
      meta: { order: [...meta.order], version: meta.version },
      workspaces,
      bookmarkTree,
      settings,
    };
  }

  /**
   * Recursively serialize bookmark tree nodes, stripping device-local IDs.
   * @param {chrome.bookmarks.BookmarkTreeNode[]} nodes
   * @returns {Array<{title: string, url?: string, children?: Array}>}
   */
  _serializeBookmarkNodes(nodes) {
    return nodes.map(node => {
      const entry = { title: node.title };
      if (node.url) {
        entry.url = node.url;
      }
      if (node.children && node.children.length > 0) {
        entry.children = this._serializeBookmarkNodes(node.children);
      }
      return entry;
    });
  }

  /**
   * Create a backup and trigger a file download.
   * Uses Blob URL + anchor click — no `downloads` permission needed.
   */
  async downloadBackup() {
    const backup = await this.createBackup();
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `arc-spaces-backup-${dateStr}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    // Cleanup
    requestAnimationFrame(() => {
      if (a.parentNode) a.parentNode.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  // ── Validation ─────────────────────────────────────

  /**
   * Validate a parsed backup object for required structure and data.
   * @param {Object} data - Parsed JSON data
   * @returns {{ valid: boolean, error?: string, summary?: Object }}
   */
  validateBackup(data) {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'Invalid file: not a JSON object' };
    }
    if (data.formatVersion !== 1) {
      return { valid: false, error: `Unsupported backup format version: ${data.formatVersion}` };
    }
    if (!data.meta || !Array.isArray(data.meta.order) || data.meta.order.length === 0) {
      return { valid: false, error: 'Backup contains no workspace data' };
    }
    if (!data.workspaces || typeof data.workspaces !== 'object') {
      return { valid: false, error: 'Backup is missing workspace configurations' };
    }

    // Count workspaces with actual data
    const wsCount = data.meta.order.filter(id => data.workspaces[id]).length;
    if (wsCount === 0) {
      return { valid: false, error: 'No valid workspaces found in backup' };
    }

    // Count total bookmarks
    let bookmarkCount = 0;
    if (data.bookmarkTree) {
      for (const wsId of data.meta.order) {
        bookmarkCount += this._countBookmarks(data.bookmarkTree[wsId] || []);
      }
    }

    const wsNames = data.meta.order
      .map(id => data.workspaces[id]?.name)
      .filter(Boolean);

    return {
      valid: true,
      summary: {
        workspaceCount: wsCount,
        workspaceNames: wsNames,
        bookmarkCount,
        createdAt: data.createdAt,
        extensionVersion: data.extensionVersion,
      }
    };
  }

  /**
   * Count bookmarks (not folders) in a tree.
   */
  _countBookmarks(nodes) {
    let count = 0;
    for (const node of nodes) {
      if (node.url) count++;
      if (node.children) count += this._countBookmarks(node.children);
    }
    return count;
  }

  // ── Import ─────────────────────────────────────────

  /**
   * Read and parse a JSON backup file.
   * @param {File} file
   * @returns {Promise<Object>}
   */
  readBackupFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(reader.result);
          resolve(data);
        } catch (err) {
          reject(new Error('Invalid JSON file'));
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsText(file);
    });
  }

  /**
   * Restore workspaces and bookmarks from a validated backup.
   * Clears all existing workspace data and bookmark folders, then
   * recreates everything from the backup.
   * @param {Object} backup - Validated backup data
   */
  async restoreBackup(backup) {
    // 1. Delete existing workspace items from sync
    const currentMeta = await storageService.getWorkspaceMeta();
    if (currentMeta && currentMeta.order) {
      for (const wsId of currentMeta.order) {
        await storageService.deleteWorkspaceItem(wsId);
      }
    }
    try { await chrome.storage.sync.remove('ws_meta'); } catch { /* ignore */ }

    // 2. Remove existing Arc Spaces bookmark folder tree
    const currentRootId = await storageService.getArcSpacesRootIdLocal();
    if (currentRootId) {
      try { await bookmarkService.removeTree(currentRootId); } catch { /* may not exist */ }
    }

    // 3. Create fresh "Arc Spaces" root folder
    const otherBookmarksId = await this._getOtherBookmarksId();
    const arcRoot = await bookmarkService.create({
      parentId: otherBookmarksId,
      title: 'Arc Spaces'
    });
    await storageService.saveArcSpacesRootIdLocal(arcRoot.id);

    // 4. Recreate each workspace
    const rootFolderIds = {};
    const order = [];

    for (const wsId of backup.meta.order) {
      const wsData = backup.workspaces[wsId];
      if (!wsData) continue;

      // Create workspace bookmark folder
      const wsFolder = await bookmarkService.create({
        parentId: arcRoot.id,
        title: wsData.name
      });
      rootFolderIds[wsId] = wsFolder.id;
      order.push(wsId);

      // Recursively recreate bookmark tree
      const treeNodes = (backup.bookmarkTree && backup.bookmarkTree[wsId]) || [];
      const idMap = new Map();
      await this._recreateBookmarkTree(wsFolder.id, treeNodes, idMap);

      // Remap pinned bookmark references
      const pinnedBookmarks = (wsData.pinnedBookmarks || []).map(pin => {
        const newId = this._findBookmarkIdInMap(pin, idMap);
        return { ...pin, id: newId || pin.id };
      });

      // Save workspace config to sync (without device-local fields)
      const syncItem = {
        id: wsData.id,
        name: wsData.name,
        icon: wsData.icon || 'folder',
        color: wsData.color,
        colorScheme: wsData.colorScheme,
        pinnedBookmarks,
        shortcuts: wsData.shortcuts || [],
        created: wsData.created || Date.now(),
      };
      await storageService.saveWorkspaceItem(wsId, syncItem);
    }

    // 5. Save ws_meta
    await storageService.saveWorkspaceMeta({ order, version: 2 });

    // 6. Save ws_local
    const activeId = order[0] || null;
    await storageService.saveWorkspaceLocal({
      activeWorkspaceId: activeId,
      rootFolderIds,
    });

    // 7. Restore settings
    if (backup.settings) {
      await storageService.saveSettings(backup.settings);
    }
  }

  /**
   * Recursively create bookmarks/folders from backup tree data.
   * Populates idMap with url/title → newId for pinned bookmark remapping.
   */
  async _recreateBookmarkTree(parentId, nodes, idMap) {
    for (const node of nodes) {
      if (node.url) {
        const created = await bookmarkService.create({
          parentId,
          title: node.title || '',
          url: node.url,
        });
        idMap.set(node.url, created.id);
      } else {
        // Folder
        const folder = await bookmarkService.create({
          parentId,
          title: node.title || '',
        });
        idMap.set(`folder:${node.title}`, folder.id);
        if (node.children && node.children.length > 0) {
          await this._recreateBookmarkTree(folder.id, node.children, idMap);
        }
      }
    }
  }

  /**
   * Find a newly-created bookmark ID for a pinned bookmark reference.
   */
  _findBookmarkIdInMap(pin, idMap) {
    if (pin.url && idMap.has(pin.url)) {
      return idMap.get(pin.url);
    }
    if (pin.title && !pin.url && idMap.has(`folder:${pin.title}`)) {
      return idMap.get(`folder:${pin.title}`);
    }
    return null;
  }

  /**
   * Dynamically find the "Other Bookmarks" folder ID.
   */
  async _getOtherBookmarksId() {
    const tree = await bookmarkService.getTree();
    const root = tree[0];
    const otherBookmarks = root.children.find(child =>
      child.title.toLowerCase() === 'other bookmarks'
    );
    if (otherBookmarks) return otherBookmarks.id;
    if (root.children.length >= 2) return root.children[1].id;
    return root.children[0].id;
  }
}

export const backupService = new BackupService();
