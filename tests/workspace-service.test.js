// Tests for the workspace service — CRUD, pin/unpin, sync reconciliation
// Uses v2 split-key storage format (ws_meta + ws_{id} + ws_local)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetMocks, seedBookmarks } from './setup.js';
import { workspaceService } from '../sidepanel/services/workspace-service.js';
import { bookmarkService } from '../sidepanel/services/bookmark-service.js';
import { storageService } from '../sidepanel/services/storage-service.js';

/**
 * Seed v2 split-key workspace data directly into storage.
 * Each workspace gets its own sync key + ws_meta for order.
 * Local state (activeWorkspaceId, rootFolderIds) in ws_local.
 */
async function seedV2Workspaces({ workspaces, arcRootId }) {
  const order = [];
  const rootFolderIds = {};
  let activeId = null;

  for (const ws of workspaces) {
    order.push(ws.id);
    rootFolderIds[ws.id] = ws.rootFolderId;
    if (!activeId) activeId = ws.id;

    // Save workspace item to sync (without rootFolderId — it's device-local)
    const syncItem = { ...ws };
    delete syncItem.rootFolderId;
    delete syncItem.pinnedBookmarkIds;
    await storageService.saveWorkspaceItem(ws.id, syncItem);
  }

  await storageService.saveWorkspaceMeta({ order, version: 2 });
  await storageService.saveWorkspaceLocal({ activeWorkspaceId: activeId, rootFolderIds });
  if (arcRootId) {
    await storageService.saveArcSpacesRootIdLocal(arcRootId);
  }
}

describe('WorkspaceService', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── init() — first run ─────────────────────────

  it('creates default workspace on first run', async () => {
    await workspaceService.init();

    const all = workspaceService.getAll();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0].name).toBeTruthy();

    const active = workspaceService.getActive();
    expect(active).toBeTruthy();
    expect(active.rootFolderId).toBeTruthy();
  });

  it('first run creates v2 split-key format', async () => {
    await workspaceService.init();

    // Should have ws_meta in sync
    const meta = await storageService.getWorkspaceMeta();
    expect(meta).toBeTruthy();
    expect(meta.version).toBe(2);
    expect(meta.order.length).toBeGreaterThanOrEqual(1);

    // Should have individual ws_ keys
    const wsItem = await storageService.getWorkspaceItem(meta.order[0]);
    expect(wsItem).toBeTruthy();
    expect(wsItem.name).toBeTruthy();

    // Should have ws_local in local storage
    const local = await storageService.getWorkspaceLocal();
    expect(local.activeWorkspaceId).toBeTruthy();
    expect(Object.keys(local.rootFolderIds).length).toBeGreaterThanOrEqual(1);
  });

  // ── getAll / getActive / getById ───────────────

  it('getAll returns all workspaces', async () => {
    await workspaceService.init();
    const all = workspaceService.getAll();
    expect(Array.isArray(all)).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('getActive returns the active workspace', async () => {
    await workspaceService.init();
    const active = workspaceService.getActive();
    expect(active).toBeTruthy();
    expect(active.id).toBeTruthy();
  });

  it('getById returns a specific workspace', async () => {
    await workspaceService.init();
    const active = workspaceService.getActive();
    const fetched = workspaceService.getById(active.id);
    expect(fetched.name).toBe(active.name);
  });

  it('getById returns null for unknown id', async () => {
    await workspaceService.init();
    const result = workspaceService.getById('nonexistent');
    expect(result).toBeNull();
  });

  // ── create ─────────────────────────────────────

  it('creates a new workspace with bookmark folder', async () => {
    await workspaceService.init();
    const initialCount = workspaceService.getAll().length;

    const newWs = await workspaceService.create('Work', 'blue');

    expect(newWs.name).toBe('Work');
    expect(newWs.colorScheme).toBe('blue');
    expect(newWs.rootFolderId).toBeTruthy();
    expect(workspaceService.getAll().length).toBe(initialCount + 1);

    // Verify bookmark folder was created
    const folder = await bookmarkService.get(newWs.rootFolderId);
    expect(folder).toBeTruthy();
    expect(folder.title).toBe('Work');
  });

  it('creates a workspace and saves as individual sync key', async () => {
    await workspaceService.init();
    const newWs = await workspaceService.create('Work', 'blue');

    // Individual workspace item should be in sync storage
    const syncItem = await storageService.getWorkspaceItem(newWs.id);
    expect(syncItem).toBeTruthy();
    expect(syncItem.name).toBe('Work');

    // Meta should include the new workspace
    const meta = await storageService.getWorkspaceMeta();
    expect(meta.order).toContain(newWs.id);

    // rootFolderId should NOT be in sync item
    expect(syncItem.rootFolderId).toBeUndefined();

    // rootFolderId should be in local state
    const local = await storageService.getWorkspaceLocal();
    expect(local.rootFolderIds[newWs.id]).toBeTruthy();
  });

  // ── switchTo ───────────────────────────────────

  it('switches the active workspace', async () => {
    await workspaceService.init();
    const ws2 = await workspaceService.create('Second', 'green');

    await workspaceService.switchTo(ws2.id);

    const active = workspaceService.getActive();
    expect(active.id).toBe(ws2.id);
    expect(active.name).toBe('Second');
  });

  it('switchTo only writes to local storage (no sync write)', async () => {
    await workspaceService.init();
    const ws2 = await workspaceService.create('Second', 'green');

    // Clear call counts after setup
    chrome.storage.sync.set.mockClear();

    await workspaceService.switchTo(ws2.id);

    // Should NOT have written to sync
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();

    // Should have written to local
    const local = await storageService.getWorkspaceLocal();
    expect(local.activeWorkspaceId).toBe(ws2.id);
  });

  // ── rename ─────────────────────────────────────

  it('renames a workspace and its bookmark folder', async () => {
    await workspaceService.init();
    const ws = workspaceService.getActive();

    await workspaceService.rename(ws.id, 'Renamed Workspace');

    const updated = workspaceService.getById(ws.id);
    expect(updated.name).toBe('Renamed Workspace');

    // Bookmark folder should also be renamed
    const folder = await bookmarkService.get(ws.rootFolderId);
    expect(folder.title).toBe('Renamed Workspace');
  });

  // ── delete ─────────────────────────────────────

  it('deletes a workspace and its bookmark folder', async () => {
    await workspaceService.init();
    const ws2 = await workspaceService.create('ToDelete', 'red');
    const count = workspaceService.getAll().length;

    await workspaceService.delete(ws2.id);

    expect(workspaceService.getAll().length).toBe(count - 1);
    expect(workspaceService.getById(ws2.id)).toBeNull();
  });

  it('delete removes workspace from sync and updates meta', async () => {
    await workspaceService.init();
    const ws2 = await workspaceService.create('ToDelete', 'red');

    await workspaceService.delete(ws2.id);

    // Workspace item should be removed from sync
    const syncItem = await storageService.getWorkspaceItem(ws2.id);
    expect(syncItem).toBeNull();

    // Meta should not include the deleted workspace
    const meta = await storageService.getWorkspaceMeta();
    expect(meta.order).not.toContain(ws2.id);
  });

  it('prevents deleting the last workspace', async () => {
    await workspaceService.init();
    // Only one workspace should exist
    const all = workspaceService.getAll();
    if (all.length === 1) {
      await workspaceService.delete(all[0].id);
      // Should still have 1 workspace
      expect(workspaceService.getAll().length).toBe(1);
    }
  });

  // ── pin / unpin ────────────────────────────────

  it('pins a bookmark', async () => {
    await workspaceService.init();
    const ws = workspaceService.getActive();

    // Create a bookmark in the workspace
    const bm = await bookmarkService.create({
      parentId: ws.rootFolderId,
      title: 'Test',
      url: 'https://test.com',
    });

    await workspaceService.pinBookmark(bm.id);

    expect(workspaceService.isPinned(bm.id)).toBe(true);
    expect(ws.pinnedBookmarkIds).toContain(bm.id);
  });

  it('unpins a bookmark', async () => {
    await workspaceService.init();
    const ws = workspaceService.getActive();
    const bm = await bookmarkService.create({
      parentId: ws.rootFolderId,
      title: 'Test',
      url: 'https://test.com',
    });

    await workspaceService.pinBookmark(bm.id);
    expect(workspaceService.isPinned(bm.id)).toBe(true);

    await workspaceService.unpinBookmark(bm.id);
    expect(workspaceService.isPinned(bm.id)).toBe(false);
  });

  it('isPinned returns false when no active workspace', () => {
    // Before init, no workspace loaded
    expect(workspaceService.isPinned('anything')).toBe(false);
  });

  it('does not pin the same bookmark twice', async () => {
    await workspaceService.init();
    const ws = workspaceService.getActive();
    const bm = await bookmarkService.create({
      parentId: ws.rootFolderId,
      title: 'Test',
      url: 'https://test.com',
    });

    await workspaceService.pinBookmark(bm.id);
    await workspaceService.pinBookmark(bm.id);

    expect(ws.pinnedBookmarkIds.filter((id) => id === bm.id).length).toBe(1);
  });

  // ── _reconcileFolders (sync fix) ───────────────

  describe('_reconcileFolders', () => {
    it('remaps workspace rootFolderId when folder exists by name', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const localFolder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: '9999', created: Date.now(),
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws).toBeTruthy();
      expect(ws.rootFolderId).toBe(localFolder.id);
    });

    it('creates folder locally when it does not exist by name', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Work Projects', icon: 'folder', color: '#3B82F6',
          colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: '8888', created: Date.now(),
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws).toBeTruthy();
      expect(ws.rootFolderId).not.toBe('8888');

      const folder = await bookmarkService.get(ws.rootFolderId);
      expect(folder).toBeTruthy();
      expect(folder.title).toBe('Work Projects');
    });

    it('handles multiple workspaces with stale IDs', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [
          {
            id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
            colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
            rootFolderId: '7777', created: Date.now(),
          },
          {
            id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
            colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [],
            rootFolderId: '6666', created: Date.now(),
          },
        ],
      });

      await workspaceService.init();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);

      const personal = workspaceService.getById('ws1');
      expect(personal.rootFolderId).toBe(folder1.id);

      const work = workspaceService.getById('ws2');
      const workFolder = await bookmarkService.get(work.rootFolderId);
      expect(workFolder).toBeTruthy();
      expect(workFolder.title).toBe('Work');
    });

    it('does nothing when all folder IDs are valid', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: folder.id, created: Date.now(),
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws.rootFolderId).toBe(folder.id);
    });
  });

  // ── pinBookmark metadata ──────────────────────────

  describe('pin/unpin with metadata', () => {
    it('pinBookmark stores url and title metadata', async () => {
      await workspaceService.init();
      const ws = workspaceService.getActive();
      const bm = await bookmarkService.create({
        parentId: ws.rootFolderId,
        title: 'Google',
        url: 'https://google.com',
      });

      await workspaceService.pinBookmark(bm.id);

      expect(ws.pinnedBookmarks).toBeTruthy();
      expect(ws.pinnedBookmarks.length).toBe(1);
      expect(ws.pinnedBookmarks[0]).toEqual({
        id: bm.id,
        url: 'https://google.com',
        title: 'Google',
      });
    });

    it('pinBookmark stores title only for folders', async () => {
      await workspaceService.init();
      const ws = workspaceService.getActive();
      const folder = await bookmarkService.create({
        parentId: ws.rootFolderId,
        title: 'Dev Resources',
      });

      await workspaceService.pinBookmark(folder.id);

      expect(ws.pinnedBookmarks[0]).toEqual({
        id: folder.id,
        title: 'Dev Resources',
      });
    });

    it('unpinBookmark cleans up metadata', async () => {
      await workspaceService.init();
      const ws = workspaceService.getActive();
      const bm = await bookmarkService.create({
        parentId: ws.rootFolderId,
        title: 'Test',
        url: 'https://test.com',
      });

      await workspaceService.pinBookmark(bm.id);
      expect(ws.pinnedBookmarks.length).toBe(1);

      await workspaceService.unpinBookmark(bm.id);
      expect(ws.pinnedBookmarks.length).toBe(0);
    });

    it('pinBookmark saves to individual sync key', async () => {
      await workspaceService.init();
      const ws = workspaceService.getActive();
      const bm = await bookmarkService.create({
        parentId: ws.rootFolderId,
        title: 'Google',
        url: 'https://google.com',
      });

      await workspaceService.pinBookmark(bm.id);

      // Check individual sync key
      const syncItem = await storageService.getWorkspaceItem(ws.id);
      expect(syncItem.pinnedBookmarks.length).toBe(1);
      expect(syncItem.pinnedBookmarks[0].url).toBe('https://google.com');
      // pinnedBookmarkIds should NOT be in sync
      expect(syncItem.pinnedBookmarkIds).toBeUndefined();
    });
  });

  // ── _reconcilePinnedBookmarks ────────────────────

  describe('_reconcilePinnedBookmarks', () => {
    it('keeps valid pinned IDs unchanged', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const bm = await bookmarkService.create({ parentId: folder.id, title: 'Google', url: 'https://google.com' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', rootFolderId: folder.id, created: Date.now(),
          pinnedBookmarks: [{ id: bm.id, url: 'https://google.com', title: 'Google' }],
          shortcuts: [],
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws.pinnedBookmarkIds).toEqual([bm.id]);
      expect(ws.pinnedBookmarks[0].id).toBe(bm.id);
    });

    it('remaps stale pinned IDs by URL match', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const bm = await bookmarkService.create({ parentId: folder.id, title: 'Google', url: 'https://google.com' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', rootFolderId: folder.id, created: Date.now(),
          pinnedBookmarks: [{ id: '9999', url: 'https://google.com', title: 'Google' }],
          shortcuts: [],
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws.pinnedBookmarkIds).toEqual([bm.id]);
      expect(ws.pinnedBookmarks[0].id).toBe(bm.id);
      expect(ws.pinnedBookmarks[0].url).toBe('https://google.com');
    });

    it('remaps stale pinned folder IDs by title match', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const wsFolder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const subFolder = await bookmarkService.create({ parentId: wsFolder.id, title: 'Dev Resources' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', rootFolderId: wsFolder.id, created: Date.now(),
          pinnedBookmarks: [{ id: '8888', title: 'Dev Resources' }],
          shortcuts: [],
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws.pinnedBookmarkIds).toEqual([subFolder.id]);
    });

    it('drops pinned IDs that cannot be reconciled', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', rootFolderId: folder.id, created: Date.now(),
          pinnedBookmarks: [{ id: '9999', url: 'https://nonexistent.com', title: 'Nope' }],
          shortcuts: [],
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws.pinnedBookmarkIds).toEqual([]);
      expect(ws.pinnedBookmarks).toEqual([]);
    });

    it('handles workspace with no pinned items', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
          colorScheme: 'purple', rootFolderId: folder.id, created: Date.now(),
          pinnedBookmarks: [], shortcuts: [],
        }],
      });

      await workspaceService.init();

      const ws = workspaceService.getActive();
      expect(ws.pinnedBookmarkIds).toEqual([]);
    });
  });

  // ── changeColor ────────────────────────────────

  it('changes workspace color', async () => {
    await workspaceService.init();
    const ws = workspaceService.getActive();

    await workspaceService.changeColor(ws.id, 'red');

    const updated = workspaceService.getById(ws.id);
    expect(updated.colorScheme).toBe('red');
    expect(updated.color).toBe('#EF4444');
  });

  // ── colors getter ──────────────────────────────

  it('exposes color palette', () => {
    const colors = workspaceService.colors;
    expect(Array.isArray(colors)).toBe(true);
    expect(colors.length).toBe(9);
    expect(colors[0]).toHaveProperty('name');
    expect(colors[0]).toHaveProperty('color');
  });

  // ── v1 → v2 Migration ─────────────────────────

  describe('v1 to v2 migration', () => {
    it('migrates single-key workspaces to split-key format', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Work' });

      // Store as v1 format (single "workspaces" key)
      await storageService.saveWorkspaces({
        activeWorkspaceId: 'ws1',
        order: ['ws1', 'ws2'],
        items: {
          ws1: {
            id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
            colorScheme: 'purple', pinnedBookmarkIds: [],
            pinnedBookmarks: [], shortcuts: [],
            rootFolderId: folder1.id, created: 1000,
          },
          ws2: {
            id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
            colorScheme: 'blue', pinnedBookmarkIds: [],
            pinnedBookmarks: [], shortcuts: [],
            rootFolderId: folder2.id, created: 2000,
          },
        },
      });
      await storageService.saveArcSpacesRootIdLocal(arcRoot.id);

      await workspaceService.init();

      // All workspaces should be available
      const all = workspaceService.getAll();
      expect(all.length).toBe(2);

      // ws_meta should now exist in sync
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.version).toBe(2);
      expect(meta.order).toEqual(['ws1', 'ws2']);

      // Individual items in sync
      const ws1 = await storageService.getWorkspaceItem('ws1');
      expect(ws1.name).toBe('Personal');
      expect(ws1.rootFolderId).toBeUndefined(); // Stripped from sync

      // Old v1 key should be removed
      const oldData = await storageService.getWorkspaces();
      expect(oldData).toBeNull();

      // Local state should have rootFolderIds
      const local = await storageService.getWorkspaceLocal();
      expect(local.rootFolderIds.ws1).toBe(folder1.id);
      expect(local.rootFolderIds.ws2).toBe(folder2.id);
    });
  });

  // ── Sync Safety ──────────────────────────────────

  describe('sync safety', () => {
    it('does not overwrite synced workspaces on first-run re-check', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Work' });

      // Pre-populate with v2 format (simulating Device A's data)
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [
          {
            id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
            colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
            rootFolderId: folder1.id, created: Date.now(),
          },
          {
            id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
            colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [],
            rootFolderId: folder2.id, created: Date.now(),
          },
        ],
      });

      await workspaceService.init();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
      expect(all.map(ws => ws.name).sort()).toEqual(['Personal', 'Work']);
    });

    it('stores arcSpacesRootId in local storage (not sync)', async () => {
      await workspaceService.init();

      const localData = await chrome.storage.local.get('arcSpacesRootId');
      expect(localData.arcSpacesRootId).toBeTruthy();
    });

    it('new workspaces have shortcuts array initialized', async () => {
      await workspaceService.init();
      const ws = workspaceService.getActive();
      expect(ws.shortcuts).toEqual([]);
    });

    it('rootFolderId is NOT stored in sync workspace items', async () => {
      await workspaceService.init();
      const active = workspaceService.getActive();

      // Read directly from sync
      const syncItem = await storageService.getWorkspaceItem(active.id);
      expect(syncItem.rootFolderId).toBeUndefined();

      // But should exist in memory
      expect(active.rootFolderId).toBeTruthy();
    });

    it('activeWorkspaceId is device-local', async () => {
      await workspaceService.init();
      const ws2 = await workspaceService.create('Second', 'green');
      await workspaceService.switchTo(ws2.id);

      // Should be in local storage
      const local = await storageService.getWorkspaceLocal();
      expect(local.activeWorkspaceId).toBe(ws2.id);

      // ws_meta should NOT contain activeWorkspaceId
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.activeWorkspaceId).toBeUndefined();
    });
  });

  // ── Website Shortcuts ────────────────────────────

  describe('website shortcuts', () => {
    it('getShortcuts returns empty array by default', async () => {
      await workspaceService.init();
      expect(workspaceService.getShortcuts()).toEqual([]);
    });

    it('addShortcut stores url and title', async () => {
      await workspaceService.init();
      await workspaceService.addShortcut('https://google.com', 'Google');
      const shortcuts = workspaceService.getShortcuts();
      expect(shortcuts.length).toBe(1);
      expect(shortcuts[0]).toEqual({ url: 'https://google.com', title: 'Google' });
    });

    it('addShortcut does not add duplicate URLs', async () => {
      await workspaceService.init();
      await workspaceService.addShortcut('https://google.com', 'Google');
      await workspaceService.addShortcut('https://google.com', 'Google Again');
      expect(workspaceService.getShortcuts().length).toBe(1);
    });

    it('addShortcut enforces max of 8 shortcuts', async () => {
      await workspaceService.init();
      for (let i = 0; i < 10; i++) {
        await workspaceService.addShortcut(`https://site${i}.com`, `Site ${i}`);
      }
      expect(workspaceService.getShortcuts().length).toBe(8);
    });

    it('removeShortcut removes by URL', async () => {
      await workspaceService.init();
      await workspaceService.addShortcut('https://google.com', 'Google');
      await workspaceService.addShortcut('https://github.com', 'GitHub');
      await workspaceService.removeShortcut('https://google.com');
      const shortcuts = workspaceService.getShortcuts();
      expect(shortcuts.length).toBe(1);
      expect(shortcuts[0].url).toBe('https://github.com');
    });

    it('shortcuts persist to individual sync key', async () => {
      await workspaceService.init();
      const ws = workspaceService.getActive();
      await workspaceService.addShortcut('https://google.com', 'Google');

      const syncItem = await storageService.getWorkspaceItem(ws.id);
      expect(syncItem.shortcuts.length).toBe(1);
      expect(syncItem.shortcuts[0].url).toBe('https://google.com');
    });

    it('new workspaces have empty shortcuts array', async () => {
      await workspaceService.init();
      const newWs = await workspaceService.create('Work', 'blue');
      expect(newWs.shortcuts).toEqual([]);
    });
  });
});
