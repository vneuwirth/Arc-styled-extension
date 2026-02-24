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
    // Disable first-run delay in tests (normally 2s to let Chrome sync propagate)
    workspaceService._firstRunDelayMs = 0;
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

  // ── New device sync (arcSpacesRootId is null) ──

  describe('new device sync (no local state)', () => {
    it('syncs workspaces when arcSpacesRootId is null (new device)', async () => {
      // Simulate Device A having already created workspaces in sync storage
      // But Device B has NO local state at all (no arcSpacesRootId, no ws_local)

      // Seed v2 data into sync storage WITHOUT local state
      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
        created: Date.now(),
      });
      await storageService.saveWorkspaceItem('ws2', {
        id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [],
        created: Date.now(),
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1', 'ws2'], version: 2 });
      // Do NOT seed ws_local or arcSpacesRootId — simulating a brand new device

      await workspaceService.init();
      // Reinstall detected — complete init (simulating user choosing "Restore")
      if (workspaceService.needsReinstallPrompt) {
        await workspaceService.continueInit();
      }

      // Both workspaces should be loaded
      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
      expect(all.map(ws => ws.name).sort()).toEqual(['Personal', 'Work']);

      // Each should have a valid rootFolderId (created locally)
      for (const ws of all) {
        expect(ws.rootFolderId).toBeTruthy();
        const folder = await bookmarkService.get(ws.rootFolderId);
        expect(folder).toBeTruthy();
        expect(folder.title).toBe(ws.name);
      }

      // arcSpacesRootId should now be set in local storage
      const arcRootId = await storageService.getArcSpacesRootIdLocal();
      expect(arcRootId).toBeTruthy();
    });

    it('finds existing Arc Spaces root on new device', async () => {
      // Arc Spaces folder already exists from a previous install
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const personalFolder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      // Sync data present but no local state
      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
        created: Date.now(),
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1'], version: 2 });

      await workspaceService.init();
      // Reinstall detected — complete init (simulating user choosing "Restore")
      if (workspaceService.needsReinstallPrompt) {
        await workspaceService.continueInit();
      }

      const ws = workspaceService.getActive();
      expect(ws).toBeTruthy();
      // Should reuse existing "Personal" folder, not create a new one
      expect(ws.rootFolderId).toBe(personalFolder.id);
    });

    it('validates folders skip workspaces with no rootFolderId', async () => {
      // Sync data present, no local state, _reconcileFolders should assign folders
      // but if it doesn't for any reason, _validateFolders should NOT delete the workspace
      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'TestWs', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
        created: Date.now(),
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1'], version: 2 });

      await workspaceService.init();

      // Workspace should still exist (not deleted by _validateFolders)
      const all = workspaceService.getAll();
      expect(all.length).toBeGreaterThanOrEqual(1);
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

  // ── Multi-Workspace Cross-Device Sync ──────────────

  describe('multi-workspace cross-device sync', () => {
    it('discovers orphaned ws_* keys when ws_meta is missing', async () => {
      // Simulate: Device A wrote workspace data to sync, but ws_meta
      // was lost (or hasn't arrived). Only ws_* keys exist, no ws_meta.
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws_12345', {
        id: 'ws_12345', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      // Do NOT write ws_meta — simulating it was lost or never arrived

      await workspaceService.init();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
      expect(all.map(ws => ws.name).sort()).toEqual(['Personal', 'Work']);

      // ws_meta should now be reconstructed
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order).toContain('ws_default');
      expect(meta.order).toContain('ws_12345');
    });

    it('recovers workspaces present in sync but missing from ws_meta.order', async () => {
      // Simulate: ws_meta only has ['ws_default'], but ws_12345 data exists in sync
      // (ws_meta was overwritten by another device's _firstRunSetup)
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws_12345', {
        id: 'ws_12345', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });

      await workspaceService.init();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
      expect(all.map(ws => ws.name).sort()).toEqual(['Personal', 'Work']);

      // ws_meta should be updated to include the recovered workspace
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order).toContain('ws_default');
      expect(meta.order).toContain('ws_12345');
    });

    it('_saveMeta merges with remote to avoid dropping workspaces', async () => {
      // Setup: Device has ws_default loaded
      await workspaceService.init();

      // Simulate: another device added ws_remote to sync while we were running
      await storageService.saveWorkspaceItem('ws_remote', {
        id: 'ws_remote', name: 'Remote Work', icon: 'folder', color: '#22C55E',
        colorScheme: 'green', pinnedBookmarks: [], shortcuts: [], created: 3000,
      });
      // Externally update ws_meta to include both (as if Device A wrote it)
      await storageService.saveWorkspaceMeta({
        order: ['ws_default', 'ws_remote'], version: 2,
      });

      // Now create a workspace on this device — triggers _saveMeta with merge
      await workspaceService.create('Local New', 'blue');

      // ws_meta should contain all three: ws_default, ws_remote, and the new one
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order).toContain('ws_default');
      expect(meta.order).toContain('ws_remote');
      expect(meta.order.length).toBe(3);
    });

    it('delete still removes workspace despite merge safeguard', async () => {
      await workspaceService.init();
      const ws2 = await workspaceService.create('ToDelete', 'red');

      await workspaceService.delete(ws2.id);

      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order).not.toContain(ws2.id);
      expect(workspaceService.getById(ws2.id)).toBeNull();
    });

    it('re-init after sync change picks up new workspaces', async () => {
      // Initial setup on this device
      await workspaceService.init();
      expect(workspaceService.getAll().length).toBe(1);

      // Simulate: another device added a workspace to sync
      await storageService.saveWorkspaceItem('ws_new', {
        id: 'ws_new', name: 'New From Other Device', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 5000,
      });
      await storageService.saveWorkspaceMeta({
        order: ['ws_default', 'ws_new'], version: 2,
      });

      // Re-init (simulating what _handleRemoteSync does)
      await workspaceService.init();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
      expect(all.map(ws => ws.name)).toContain('New From Other Device');
    });
  });

  // ── Reinstall Detection ─────────────────────────

  describe('reinstall detection', () => {
    it('sets needsReinstallPrompt when sync data exists but local is empty', async () => {
      // Seed v2 data in sync but NO local state
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });
      // Explicitly do NOT seed ws_local

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(true);
      // Workspaces should be loaded (for display in prompt)
      expect(workspaceService.getAll().length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT set needsReinstallPrompt on normal init', async () => {
      // Full seed including local state
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });

      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: folder.id, created: Date.now(),
        }],
      });

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
    });

    it('does NOT set needsReinstallPrompt on first-ever install (no sync data)', async () => {
      // No sync data, no local data
      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
      // Should have run _firstRunSetup
      expect(workspaceService.getAll().length).toBeGreaterThanOrEqual(1);
    });

    it('continueInit completes initialization after restore choice', async () => {
      // Seed sync data without local state
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);

      await workspaceService.continueInit();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
      const active = workspaceService.getActive();
      expect(active).toBeTruthy();
      expect(active.name).toBe('Personal');
      expect(active.rootFolderId).toBeTruthy();
    });

    it('resetAndSetup clears sync and creates fresh workspace', async () => {
      // Seed two workspaces in sync without local state
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws_work', {
        id: 'ws_work', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default', 'ws_work'], version: 2 });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);

      await workspaceService.resetAndSetup();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
      const all = workspaceService.getAll();
      expect(all.length).toBe(1); // Fresh default workspace
      expect(all[0].name).toBe('Personal');

      // Old workspace items should be deleted from sync
      const oldWork = await storageService.getWorkspaceItem('ws_work');
      expect(oldWork).toBeNull();
    });

    it('restore picks Arc Spaces root with most children when duplicates exist', async () => {
      // Empty "Arc Spaces" folder (from a botched previous install)
      await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });

      // Real "Arc Spaces" folder with workspace subfolders and bookmarks
      const realRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const personalFolder = await bookmarkService.create({ parentId: realRoot.id, title: 'Personal' });
      await bookmarkService.create({ parentId: personalFolder.id, title: 'Google', url: 'https://google.com' });
      const workFolder = await bookmarkService.create({ parentId: realRoot.id, title: 'Work' });
      await bookmarkService.create({ parentId: workFolder.id, title: 'GitHub', url: 'https://github.com' });

      // Seed sync data without local state (reinstall scenario)
      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws2', {
        id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1', 'ws2'], version: 2 });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);
      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);

      // Should have picked the real root (with children), not the empty one
      const personal = workspaceService.getById('ws1');
      expect(personal.rootFolderId).toBe(personalFolder.id);
      const work = workspaceService.getById('ws2');
      expect(work.rootFolderId).toBe(workFolder.id);
    });

    it('restore matches renamed workspaces by position when name match fails', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'OldPersonal' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'OldWork' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      // Sync data has RENAMED workspace names
      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws2', {
        id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1', 'ws2'], version: 2 });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);
      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);

      // Should reuse existing folders (not create new empty ones)
      const personal = workspaceService.getById('ws1');
      expect(personal.rootFolderId).toBe(folder1.id);
      const work = workspaceService.getById('ws2');
      expect(work.rootFolderId).toBe(folder2.id);

      // Folders should be renamed to match sync names
      const renamedFolder1 = await bookmarkService.get(folder1.id);
      expect(renamedFolder1.title).toBe('Personal');
      const renamedFolder2 = await bookmarkService.get(folder2.id);
      expect(renamedFolder2.title).toBe('Work');
    });

    it('restore uses name match first, then positional match for remainder', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const personalFolder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      await bookmarkService.create({ parentId: personalFolder.id, title: 'Google', url: 'https://google.com' });
      const oldWorkFolder = await bookmarkService.create({ parentId: arcRoot.id, title: 'OldWorkName' });
      await bookmarkService.create({ parentId: oldWorkFolder.id, title: 'GitHub', url: 'https://github.com' });

      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws2', {
        id: 'ws2', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1', 'ws2'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();

      // "Personal" should be name-matched
      const personal = workspaceService.getById('ws1');
      expect(personal.rootFolderId).toBe(personalFolder.id);

      // "Work" should be positionally matched to the remaining folder "OldWorkName"
      const work = workspaceService.getById('ws2');
      expect(work.rootFolderId).toBe(oldWorkFolder.id);
    });

    it('restore does not create new empty folders when existing ones have bookmarks', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });

      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();

      // Should have exactly 1 folder under Arc Spaces (not 2)
      const children = await bookmarkService.getChildren(arcRoot.id);
      const folders = children.filter(c => !c.url);
      expect(folders.length).toBe(1);
      expect(folders[0].id).toBe(folder1.id);
    });

    it('restore preserves pinned bookmarks after folder remapping', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const personalFolder = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const bm = await bookmarkService.create({ parentId: personalFolder.id, title: 'Google', url: 'https://google.com' });

      await storageService.saveWorkspaceItem('ws1', {
        id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
        colorScheme: 'purple', shortcuts: [], created: 1000,
        pinnedBookmarks: [{ id: '9999', url: 'https://google.com', title: 'Google' }],
      });
      await storageService.saveWorkspaceMeta({ order: ['ws1'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();

      const ws = workspaceService.getActive();
      expect(ws.rootFolderId).toBe(personalFolder.id);
      // Pinned bookmark should be reconciled to the local bookmark's actual ID
      expect(ws.pinnedBookmarkIds).toEqual([bm.id]);
      expect(ws.pinnedBookmarks[0].url).toBe('https://google.com');
    });
  });

  // ── Orphaned Bookmark Folder Adoption ──────────────

  describe('_adoptOrphanedBookmarkFolders', () => {
    it('adopts unclaimed bookmark folders after sync-based reinstall (1 sync, 3 folders)', async () => {
      // Scenario: sync partially restored with only 1 workspace,
      // but all 3 bookmark folders survive under Arc Spaces.
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      const folder3 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Germany' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });
      await bookmarkService.create({ parentId: folder3.id, title: 'Berlin', url: 'https://berlin.de' });

      // Seed only 1 workspace in sync (simulating partial sync recovery)
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });
      // No local state — simulating reinstall

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);

      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(3);
      expect(all.map(ws => ws.name).sort()).toEqual(['Developer', 'Germany', 'Personal']);

      // Each workspace should have valid rootFolderId pointing to existing folder
      for (const ws of all) {
        expect(ws.rootFolderId).toBeTruthy();
        const folder = await bookmarkService.get(ws.rootFolderId);
        expect(folder).toBeTruthy();
        expect(folder.title).toBe(ws.name);
      }
    });

    it('does not duplicate already-claimed folders', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Work' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      // Both workspaces exist in sync (fully restored)
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceItem('ws_work', {
        id: 'ws_work', name: 'Work', icon: 'folder', color: '#3B82F6',
        colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default', 'ws_work'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();

      // Should still have exactly 2, no extra adopted
      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
    });

    it('adopted workspaces get cycling colors based on existing count', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      const folder3 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Germany' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });
      await bookmarkService.create({ parentId: folder3.id, title: 'Berlin', url: 'https://berlin.de' });

      // 1 workspace already in sync (purple)
      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(3);
      // First workspace keeps its original color
      expect(all[0].colorScheme).toBe('purple');
      // Adopted workspaces start from offset 1 (blue, cyan)
      expect(all[1].colorScheme).toBe('blue');
      expect(all[2].colorScheme).toBe('cyan');
    });

    it('adopted workspaces are saved to sync storage', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();

      // ws_meta should include the adopted workspace
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order.length).toBe(2);

      // The adopted workspace should be in sync storage
      const all = workspaceService.getAll();
      const adopted = all.find(ws => ws.name === 'Developer');
      expect(adopted).toBeTruthy();
      const syncItem = await storageService.getWorkspaceItem(adopted.id);
      expect(syncItem).toBeTruthy();
      expect(syncItem.name).toBe('Developer');
      // rootFolderId should NOT be in sync
      expect(syncItem.rootFolderId).toBeUndefined();
    });

    it('re-init after adoption does not duplicate workspaces', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      await storageService.saveWorkspaceItem('ws_default', {
        id: 'ws_default', name: 'Personal', icon: 'home', color: '#7C5CFC',
        colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000,
      });
      await storageService.saveWorkspaceMeta({ order: ['ws_default'], version: 2 });

      await workspaceService.init();
      await workspaceService.continueInit();
      expect(workspaceService.getAll().length).toBe(2);

      // Re-init (simulating panel reopen)
      await workspaceService.init();
      expect(workspaceService.getAll().length).toBe(2);
    });
  });

  // ── getBookmarkFolderNames ──────────────────────────

  describe('getBookmarkFolderNames', () => {
    it('returns all subfolder names from Arc Spaces root', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      await bookmarkService.create({ parentId: arcRoot.id, title: 'Germany' });
      // Also add a non-folder bookmark (should be excluded)
      await bookmarkService.create({ parentId: arcRoot.id, title: 'Loose', url: 'https://loose.com' });

      await workspaceService.init();

      const names = await workspaceService.getBookmarkFolderNames();
      expect(names.sort()).toEqual(['Developer', 'Germany', 'Personal']);
    });

    it('returns empty array when no Arc Spaces root exists', async () => {
      const names = await workspaceService.getBookmarkFolderNames();
      expect(names).toEqual([]);
    });
  });

  // ── Bookmark-based reinstall recovery ──────────────

  describe('shortcut bookmark persistence', () => {
    it('addShortcut creates bookmark in __shortcuts__ folder', async () => {
      const { arcRoot, wsFolder } = await seedBookmarks();
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'home', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: wsFolder.id, created: Date.now(),
        }],
      });
      await workspaceService.init();

      await workspaceService.addShortcut('https://gmail.com', 'Gmail');

      // Verify __shortcuts__ folder was created with the bookmark
      const children = await bookmarkService.getChildren(wsFolder.id);
      const shortcutsFolder = children.find(c => c.title === '__shortcuts__');
      expect(shortcutsFolder).toBeTruthy();

      const bookmarks = await bookmarkService.getChildren(shortcutsFolder.id);
      expect(bookmarks.length).toBe(1);
      expect(bookmarks[0].url).toBe('https://gmail.com');
      expect(bookmarks[0].title).toBe('Gmail');
    });

    it('removeShortcut removes bookmark from __shortcuts__ folder', async () => {
      const { arcRoot, wsFolder } = await seedBookmarks();
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'home', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [],
          shortcuts: [{ url: 'https://gmail.com', title: 'Gmail' }],
          rootFolderId: wsFolder.id, created: Date.now(),
        }],
      });
      await workspaceService.init();

      // First add to create the bookmark folder
      await workspaceService.addShortcut('https://drive.google.com', 'Drive');
      // Then remove one
      await workspaceService.removeShortcut('https://gmail.com');

      const children = await bookmarkService.getChildren(wsFolder.id);
      const shortcutsFolder = children.find(c => c.title === '__shortcuts__');
      expect(shortcutsFolder).toBeTruthy();

      const bookmarks = await bookmarkService.getChildren(shortcutsFolder.id);
      expect(bookmarks.length).toBe(1);
      expect(bookmarks[0].url).toBe('https://drive.google.com');
    });

    it('removing last shortcut deletes __shortcuts__ folder', async () => {
      const { arcRoot, wsFolder } = await seedBookmarks();
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'home', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [],
          shortcuts: [{ url: 'https://gmail.com', title: 'Gmail' }],
          rootFolderId: wsFolder.id, created: Date.now(),
        }],
      });
      await workspaceService.init();

      // Sync the initial shortcut to bookmarks
      await workspaceService.addShortcut('https://gmail.com', 'Gmail'); // no-op (duplicate), but triggers sync
      await workspaceService.removeShortcut('https://gmail.com');

      const children = await bookmarkService.getChildren(wsFolder.id);
      const shortcutsFolder = children.find(c => c.title === '__shortcuts__');
      expect(shortcutsFolder).toBeFalsy();
    });

    it('adopted workspace loads shortcuts from __shortcuts__ folder', async () => {
      // Simulate reinstall: sync has 1 workspace, bookmarks have 2
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Work' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      // Create __shortcuts__ folder in folder2 with saved shortcuts
      const shortcutsFolder = await bookmarkService.create({ parentId: folder2.id, title: '__shortcuts__' });
      await bookmarkService.create({ parentId: shortcutsFolder.id, title: 'Gmail', url: 'https://gmail.com' });
      await bookmarkService.create({ parentId: shortcutsFolder.id, title: 'Drive', url: 'https://drive.google.com' });

      // Seed sync with only 1 workspace (folder1)
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'home', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: folder1.id, created: Date.now(),
        }],
      });

      await workspaceService.init();
      // Reinstall detected
      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(2);

      const workWs = all.find(ws => ws.name === 'Work');
      expect(workWs).toBeTruthy();
      expect(workWs.shortcuts.length).toBe(2);
      expect(workWs.shortcuts.map(s => s.url).sort()).toEqual([
        'https://drive.google.com',
        'https://gmail.com',
      ]);
    });

    it('bookmark-recovered workspace loads shortcuts from __shortcuts__ folder', async () => {
      // No sync data at all — full bookmark recovery
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });

      // Create __shortcuts__ folder
      const shortcutsFolder = await bookmarkService.create({ parentId: folder1.id, title: '__shortcuts__' });
      await bookmarkService.create({ parentId: shortcutsFolder.id, title: 'Gmail', url: 'https://gmail.com' });

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(true);
      const all = workspaceService.getAll();
      expect(all.length).toBe(1);
      expect(all[0].shortcuts.length).toBe(1);
      expect(all[0].shortcuts[0].url).toBe('https://gmail.com');
      expect(all[0].shortcuts[0].title).toBe('Gmail');
    });

    it('__shortcuts__ folder is created lazily on first shortcut add', async () => {
      const { arcRoot, wsFolder } = await seedBookmarks();
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [{
          id: 'ws1', name: 'Personal', icon: 'home', color: '#7C5CFC',
          colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
          rootFolderId: wsFolder.id, created: Date.now(),
        }],
      });
      await workspaceService.init();

      // Before adding any shortcut, no __shortcuts__ folder should exist
      let children = await bookmarkService.getChildren(wsFolder.id);
      let shortcutsFolder = children.find(c => c.title === '__shortcuts__');
      expect(shortcutsFolder).toBeFalsy();

      // Add a shortcut — folder should be created
      await workspaceService.addShortcut('https://gmail.com', 'Gmail');

      children = await bookmarkService.getChildren(wsFolder.id);
      shortcutsFolder = children.find(c => c.title === '__shortcuts__');
      expect(shortcutsFolder).toBeTruthy();
    });
  });

  describe('bookmark-based reinstall recovery', () => {
    it('recovers all workspaces from surviving bookmark folders (3 subfolders)', async () => {
      // No sync data at all — Chrome deleted it on uninstall.
      // But the bookmark folders survive.
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      const folder3 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Germany' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });
      await bookmarkService.create({ parentId: folder3.id, title: 'Berlin', url: 'https://berlin.de' });

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(true);
      const all = workspaceService.getAll();
      expect(all.length).toBe(3);
      expect(all.map(ws => ws.name).sort()).toEqual(['Developer', 'Germany', 'Personal']);
    });

    it('recovers single subfolder with bookmarks', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(true);
      expect(workspaceService.getAll().length).toBe(1);
      expect(workspaceService.getAll()[0].name).toBe('Personal');
    });

    it('does NOT trigger recovery for empty Arc Spaces folder', async () => {
      await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      // No subfolders at all

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
      // Should have created default workspace via normal first-run
      expect(workspaceService.getAll().length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT trigger recovery for single empty subfolder', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      // Subfolder exists but is empty — looks like a normal first-run

      await workspaceService.init();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
    });

    it('continueInit completes after bookmark recovery', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      const folder3 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Germany' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });
      await bookmarkService.create({ parentId: folder3.id, title: 'Berlin', url: 'https://berlin.de' });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);

      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(3);
      for (const ws of all) {
        expect(ws.rootFolderId).toBeTruthy();
        const folder = await bookmarkService.get(ws.rootFolderId);
        expect(folder).toBeTruthy();
        expect(folder.title).toBe(ws.name);
      }
    });

    it('resetAndSetup after bookmark recovery creates 1 fresh workspace (no loop)', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);

      await workspaceService.resetAndSetup();

      expect(workspaceService.needsReinstallPrompt).toBe(false);
      const all = workspaceService.getAll();
      expect(all.length).toBe(1);
      expect(all[0].name).toBe('Personal');
    });

    it('sync data takes priority over bookmark recovery', async () => {
      // Both sync data AND bookmark folders exist — sync path should win
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      // Seed sync data
      await seedV2Workspaces({
        arcRootId: arcRoot.id,
        workspaces: [
          {
            id: 'ws1', name: 'Personal', icon: 'folder', color: '#7C5CFC',
            colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [],
            rootFolderId: folder1.id, created: Date.now(),
          },
          {
            id: 'ws2', name: 'Developer', icon: 'folder', color: '#3B82F6',
            colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [],
            rootFolderId: folder2.id, created: Date.now(),
          },
        ],
      });

      await workspaceService.init();

      // Should use normal v2 load path (not bookmark recovery)
      const all = workspaceService.getAll();
      expect(all.length).toBe(2);
      expect(all[0].id).toBe('ws1');
    });

    it('re-init after bookmark recovery does not duplicate workspaces', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Developer' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      await workspaceService.init();
      expect(workspaceService.needsReinstallPrompt).toBe(true);
      await workspaceService.continueInit();
      expect(workspaceService.getAll().length).toBe(2);

      // Re-init (simulating panel reopen)
      await workspaceService.init();
      // Second init finds sync data written by first — no re-recovery
      expect(workspaceService.getAll().length).toBe(2);
    });

    it('first recovered workspace gets ws_default ID and home icon', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      const folder1 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Personal' });
      const folder2 = await bookmarkService.create({ parentId: arcRoot.id, title: 'Work' });
      await bookmarkService.create({ parentId: folder1.id, title: 'Google', url: 'https://google.com' });
      await bookmarkService.create({ parentId: folder2.id, title: 'GitHub', url: 'https://github.com' });

      await workspaceService.init();

      const all = workspaceService.getAll();
      expect(all[0].id).toBe('ws_default');
      expect(all[0].icon).toBe('home');
      expect(all[1].id).not.toBe('ws_default');
      expect(all[1].icon).toBe('folder');
    });

    it('recovered workspaces get cycling colors', async () => {
      const arcRoot = await bookmarkService.create({ parentId: '2', title: 'Arc Spaces' });
      for (let i = 0; i < 4; i++) {
        const folder = await bookmarkService.create({ parentId: arcRoot.id, title: `Space ${i}` });
        await bookmarkService.create({ parentId: folder.id, title: `BM ${i}`, url: `https://site${i}.com` });
      }

      await workspaceService.init();
      await workspaceService.continueInit();

      const all = workspaceService.getAll();
      expect(all.length).toBe(4);
      // Colors should cycle through WORKSPACE_COLORS
      expect(all[0].colorScheme).toBe('purple');
      expect(all[1].colorScheme).toBe('blue');
      expect(all[2].colorScheme).toBe('cyan');
      expect(all[3].colorScheme).toBe('green');
    });
  });
});
