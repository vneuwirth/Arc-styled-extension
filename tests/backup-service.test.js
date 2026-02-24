// Tests for the backup/import service — export, validate, restore

import { describe, it, expect, beforeEach } from 'vitest';
import { resetMocks, seedBookmarks } from './setup.js';
import { backupService } from '../sidepanel/services/backup-service.js';
import { workspaceService } from '../sidepanel/services/workspace-service.js';
import { storageService } from '../sidepanel/services/storage-service.js';
import { bookmarkService } from '../sidepanel/services/bookmark-service.js';

/**
 * Helper: seed workspaces and bookmarks for backup tests.
 * Creates two workspaces with bookmark trees.
 */
async function seedForBackup() {
  workspaceService._firstRunDelayMs = 0;
  await workspaceService.init();

  // Add a second workspace
  await workspaceService.create('Work', 'blue');

  // Add bookmarks to the default workspace
  const personal = workspaceService.getAll()[0];
  await bookmarkService.create({
    parentId: personal.rootFolderId,
    title: 'Google',
    url: 'https://google.com'
  });
  const subFolder = await bookmarkService.create({
    parentId: personal.rootFolderId,
    title: 'Dev Resources'
  });
  await bookmarkService.create({
    parentId: subFolder.id,
    title: 'MDN',
    url: 'https://developer.mozilla.org'
  });

  // Add bookmarks to the Work workspace
  const work = workspaceService.getAll()[1];
  await bookmarkService.create({
    parentId: work.rootFolderId,
    title: 'GitHub',
    url: 'https://github.com'
  });

  // Add a shortcut to the default workspace
  await workspaceService.addShortcut('https://example.com', 'Example');

  // Pin a bookmark
  const personalChildren = await bookmarkService.getChildren(personal.rootFolderId);
  const googleBm = personalChildren.find(c => c.url === 'https://google.com');
  if (googleBm) {
    await workspaceService.pinBookmark(googleBm.id);
  }

  return { personal, work };
}

describe('BackupService', () => {
  beforeEach(() => {
    resetMocks();
    workspaceService._firstRunDelayMs = 0;
  });

  // ── createBackup() ──────────────────────────────────

  describe('createBackup', () => {
    it('produces a valid backup structure', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      expect(backup.formatVersion).toBe(1);
      expect(backup.createdAt).toBeTruthy();
      expect(backup.createdAtMs).toBeGreaterThan(0);
      expect(backup.meta).toBeTruthy();
      expect(backup.meta.order).toBeTruthy();
      expect(backup.meta.version).toBe(2);
      expect(backup.workspaces).toBeTruthy();
      expect(backup.bookmarkTree).toBeTruthy();
      expect(backup.settings).toBeDefined();
    });

    it('includes all workspaces', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      expect(backup.meta.order.length).toBe(2);
      const wsIds = backup.meta.order;
      expect(backup.workspaces[wsIds[0]]).toBeTruthy();
      expect(backup.workspaces[wsIds[1]]).toBeTruthy();
    });

    it('strips device-local fields from workspace data', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      for (const wsId of backup.meta.order) {
        const ws = backup.workspaces[wsId];
        expect(ws.rootFolderId).toBeUndefined();
        expect(ws.pinnedBookmarkIds).toBeUndefined();
        // But should keep synced fields
        expect(ws.name).toBeTruthy();
        expect(ws.color).toBeTruthy();
        expect(ws.colorScheme).toBeTruthy();
      }
    });

    it('captures recursive bookmark tree', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      const personalId = backup.meta.order[0];
      const tree = backup.bookmarkTree[personalId];

      expect(tree.length).toBeGreaterThanOrEqual(2);

      // Should have a bookmark with URL
      const googleEntry = tree.find(n => n.url === 'https://google.com');
      expect(googleEntry).toBeTruthy();
      expect(googleEntry.title).toBe('Google');

      // Should have a subfolder with children
      const devFolder = tree.find(n => n.title === 'Dev Resources');
      expect(devFolder).toBeTruthy();
      expect(devFolder.url).toBeUndefined();
      expect(devFolder.children).toBeTruthy();
      expect(devFolder.children.length).toBe(1);
      expect(devFolder.children[0].url).toBe('https://developer.mozilla.org');
    });

    it('captures work workspace bookmark tree', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      const workId = backup.meta.order[1];
      const tree = backup.bookmarkTree[workId];

      expect(tree.length).toBe(1);
      expect(tree[0].title).toBe('GitHub');
      expect(tree[0].url).toBe('https://github.com');
    });

    it('includes shortcuts in workspace data', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      const personalId = backup.meta.order[0];
      const ws = backup.workspaces[personalId];
      expect(ws.shortcuts).toBeTruthy();
      expect(ws.shortcuts.length).toBe(1);
      expect(ws.shortcuts[0].url).toBe('https://example.com');
    });

    it('includes pinned bookmarks in workspace data', async () => {
      await seedForBackup();
      const backup = await backupService.createBackup();

      const personalId = backup.meta.order[0];
      const ws = backup.workspaces[personalId];
      expect(ws.pinnedBookmarks).toBeTruthy();
      expect(ws.pinnedBookmarks.length).toBe(1);
      expect(ws.pinnedBookmarks[0].url).toBe('https://google.com');
    });

    it('handles workspace with no bookmarks', async () => {
      workspaceService._firstRunDelayMs = 0;
      await workspaceService.init();
      // Default workspace exists but has no bookmarks (empty folder)

      const backup = await backupService.createBackup();
      const wsId = backup.meta.order[0];
      expect(backup.bookmarkTree[wsId]).toEqual([]);
    });

    it('throws when no workspace data exists', async () => {
      // No init — empty storage
      await expect(backupService.createBackup()).rejects.toThrow('No workspace data found');
    });
  });

  // ── validateBackup() ────────────────────────────────

  describe('validateBackup', () => {
    it('rejects non-object input', () => {
      expect(backupService.validateBackup(null).valid).toBe(false);
      expect(backupService.validateBackup('string').valid).toBe(false);
      expect(backupService.validateBackup(42).valid).toBe(false);
    });

    it('rejects wrong formatVersion', () => {
      const result = backupService.validateBackup({ formatVersion: 99 });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('format version');
    });

    it('rejects missing meta.order', () => {
      const result = backupService.validateBackup({ formatVersion: 1, meta: {} });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('no workspace data');
    });

    it('rejects empty meta.order', () => {
      const result = backupService.validateBackup({
        formatVersion: 1, meta: { order: [] }
      });
      expect(result.valid).toBe(false);
    });

    it('rejects missing workspaces object', () => {
      const result = backupService.validateBackup({
        formatVersion: 1, meta: { order: ['ws1'] }
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('workspace configurations');
    });

    it('rejects when no valid workspaces match order', () => {
      const result = backupService.validateBackup({
        formatVersion: 1,
        meta: { order: ['ws_missing'] },
        workspaces: {}
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('No valid workspaces');
    });

    it('accepts valid backup and produces correct summary', () => {
      const backup = {
        formatVersion: 1,
        extensionVersion: '1.0.0',
        createdAt: '2026-01-01T00:00:00.000Z',
        meta: { order: ['ws1', 'ws2'], version: 2 },
        workspaces: {
          ws1: { name: 'Personal', color: '#7C5CFC' },
          ws2: { name: 'Work', color: '#3B82F6' },
        },
        bookmarkTree: {
          ws1: [
            { title: 'Google', url: 'https://google.com' },
            { title: 'Folder', children: [
              { title: 'MDN', url: 'https://mdn.org' }
            ]}
          ],
          ws2: [
            { title: 'GitHub', url: 'https://github.com' }
          ]
        }
      };

      const result = backupService.validateBackup(backup);
      expect(result.valid).toBe(true);
      expect(result.summary.workspaceCount).toBe(2);
      expect(result.summary.workspaceNames).toEqual(['Personal', 'Work']);
      expect(result.summary.bookmarkCount).toBe(3); // Google + MDN + GitHub
      expect(result.summary.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('counts bookmarks correctly in nested folders', () => {
      const backup = {
        formatVersion: 1,
        meta: { order: ['ws1'], version: 2 },
        workspaces: { ws1: { name: 'Test' } },
        bookmarkTree: {
          ws1: [
            { title: 'A', url: 'https://a.com' },
            { title: 'Folder1', children: [
              { title: 'B', url: 'https://b.com' },
              { title: 'SubFolder', children: [
                { title: 'C', url: 'https://c.com' },
                { title: 'D', url: 'https://d.com' },
              ]}
            ]},
            { title: 'EmptyFolder', children: [] },
          ]
        }
      };

      const result = backupService.validateBackup(backup);
      expect(result.summary.bookmarkCount).toBe(4); // A + B + C + D
    });
  });

  // ── restoreBackup() ─────────────────────────────────

  describe('restoreBackup', () => {
    it('clears existing workspace data and creates new workspaces', async () => {
      // Initialize with default workspace
      await workspaceService.init();
      const originalWs = workspaceService.getAll();
      expect(originalWs.length).toBe(1);

      // Create a backup object
      const backup = {
        formatVersion: 1,
        meta: { order: ['ws_a', 'ws_b'], version: 2 },
        workspaces: {
          ws_a: { id: 'ws_a', name: 'Alpha', icon: 'home', color: '#7C5CFC', colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000 },
          ws_b: { id: 'ws_b', name: 'Beta', icon: 'folder', color: '#3B82F6', colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000 },
        },
        bookmarkTree: {
          ws_a: [{ title: 'Google', url: 'https://google.com' }],
          ws_b: [{ title: 'GitHub', url: 'https://github.com' }],
        },
        settings: { sidebarCompact: true },
      };

      await backupService.restoreBackup(backup);

      // Verify sync storage has new workspaces
      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order).toEqual(['ws_a', 'ws_b']);

      const wsA = await storageService.getWorkspaceItem('ws_a');
      expect(wsA.name).toBe('Alpha');
      const wsB = await storageService.getWorkspaceItem('ws_b');
      expect(wsB.name).toBe('Beta');

      // Old workspace should be gone
      const oldWsId = originalWs[0].id;
      const oldWs = await storageService.getWorkspaceItem(oldWsId);
      expect(oldWs).toBeNull();
    });

    it('recreates bookmark tree recursively', async () => {
      await workspaceService.init();

      const backup = {
        formatVersion: 1,
        meta: { order: ['ws1'], version: 2 },
        workspaces: {
          ws1: { id: 'ws1', name: 'Test', icon: 'home', color: '#7C5CFC', colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000 },
        },
        bookmarkTree: {
          ws1: [
            { title: 'Google', url: 'https://google.com' },
            { title: 'Dev', children: [
              { title: 'MDN', url: 'https://developer.mozilla.org' },
              { title: 'Tools', children: [
                { title: 'VS Code', url: 'https://code.visualstudio.com' },
              ]}
            ]},
          ],
        },
      };

      await backupService.restoreBackup(backup);

      // Find the new Arc Spaces root
      const rootId = await storageService.getArcSpacesRootIdLocal();
      expect(rootId).toBeTruthy();

      // Get workspace folder
      const rootChildren = await bookmarkService.getChildren(rootId);
      expect(rootChildren.length).toBe(1);
      expect(rootChildren[0].title).toBe('Test');

      // Get workspace bookmarks
      const wsChildren = await bookmarkService.getChildren(rootChildren[0].id);
      expect(wsChildren.length).toBe(2);
      expect(wsChildren[0].title).toBe('Google');
      expect(wsChildren[0].url).toBe('https://google.com');
      expect(wsChildren[1].title).toBe('Dev');

      // Check nested folder
      const devChildren = await bookmarkService.getChildren(wsChildren[1].id);
      expect(devChildren.length).toBe(2);
      expect(devChildren[0].title).toBe('MDN');
      expect(devChildren[1].title).toBe('Tools');

      // Check nested subfolder
      const toolsChildren = await bookmarkService.getChildren(devChildren[1].id);
      expect(toolsChildren.length).toBe(1);
      expect(toolsChildren[0].title).toBe('VS Code');
      expect(toolsChildren[0].url).toBe('https://code.visualstudio.com');
    });

    it('saves ws_local with rootFolderIds and active workspace', async () => {
      await workspaceService.init();

      const backup = {
        formatVersion: 1,
        meta: { order: ['ws_a', 'ws_b'], version: 2 },
        workspaces: {
          ws_a: { id: 'ws_a', name: 'Alpha', icon: 'home', color: '#7C5CFC', colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000 },
          ws_b: { id: 'ws_b', name: 'Beta', icon: 'folder', color: '#3B82F6', colorScheme: 'blue', pinnedBookmarks: [], shortcuts: [], created: 2000 },
        },
        bookmarkTree: { ws_a: [], ws_b: [] },
      };

      await backupService.restoreBackup(backup);

      const local = await storageService.getWorkspaceLocal();
      expect(local.activeWorkspaceId).toBe('ws_a'); // First in order
      expect(local.rootFolderIds.ws_a).toBeTruthy();
      expect(local.rootFolderIds.ws_b).toBeTruthy();
    });

    it('restores settings', async () => {
      await workspaceService.init();

      const backup = {
        formatVersion: 1,
        meta: { order: ['ws1'], version: 2 },
        workspaces: {
          ws1: { id: 'ws1', name: 'Test', icon: 'home', color: '#7C5CFC', colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000 },
        },
        bookmarkTree: { ws1: [] },
        settings: { sidebarCompact: true, onboardingDismissed: true },
      };

      await backupService.restoreBackup(backup);

      const settings = await storageService.getSettings();
      expect(settings.sidebarCompact).toBe(true);
      expect(settings.onboardingDismissed).toBe(true);
    });

    it('remaps pinned bookmarks by URL after recreation', async () => {
      await workspaceService.init();

      const backup = {
        formatVersion: 1,
        meta: { order: ['ws1'], version: 2 },
        workspaces: {
          ws1: {
            id: 'ws1', name: 'Test', icon: 'home', color: '#7C5CFC', colorScheme: 'purple',
            shortcuts: [], created: 1000,
            pinnedBookmarks: [
              { id: 'old-stale-id', url: 'https://google.com', title: 'Google' }
            ],
          },
        },
        bookmarkTree: {
          ws1: [
            { title: 'Google', url: 'https://google.com' },
          ],
        },
      };

      await backupService.restoreBackup(backup);

      const wsItem = await storageService.getWorkspaceItem('ws1');
      expect(wsItem.pinnedBookmarks.length).toBe(1);
      // The ID should be remapped to the newly created bookmark's ID
      expect(wsItem.pinnedBookmarks[0].id).not.toBe('old-stale-id');
      // Verify the new ID actually exists as a bookmark
      const bm = await bookmarkService.get(wsItem.pinnedBookmarks[0].id);
      expect(bm).toBeTruthy();
      expect(bm.url).toBe('https://google.com');
    });

    it('remaps pinned folders by title after recreation', async () => {
      await workspaceService.init();

      const backup = {
        formatVersion: 1,
        meta: { order: ['ws1'], version: 2 },
        workspaces: {
          ws1: {
            id: 'ws1', name: 'Test', icon: 'home', color: '#7C5CFC', colorScheme: 'purple',
            shortcuts: [], created: 1000,
            pinnedBookmarks: [
              { id: 'old-folder-id', title: 'Dev Resources' }
            ],
          },
        },
        bookmarkTree: {
          ws1: [
            { title: 'Dev Resources', children: [
              { title: 'MDN', url: 'https://mdn.org' }
            ]},
          ],
        },
      };

      await backupService.restoreBackup(backup);

      const wsItem = await storageService.getWorkspaceItem('ws1');
      expect(wsItem.pinnedBookmarks.length).toBe(1);
      expect(wsItem.pinnedBookmarks[0].id).not.toBe('old-folder-id');
      // Verify the new ID is actually a folder
      const folder = await bookmarkService.get(wsItem.pinnedBookmarks[0].id);
      expect(folder).toBeTruthy();
      expect(folder.title).toBe('Dev Resources');
    });

    it('skips workspace IDs in meta.order that have no data', async () => {
      await workspaceService.init();

      const backup = {
        formatVersion: 1,
        meta: { order: ['ws_exists', 'ws_missing'], version: 2 },
        workspaces: {
          ws_exists: { id: 'ws_exists', name: 'Exists', icon: 'home', color: '#7C5CFC', colorScheme: 'purple', pinnedBookmarks: [], shortcuts: [], created: 1000 },
          // ws_missing intentionally absent
        },
        bookmarkTree: { ws_exists: [] },
      };

      await backupService.restoreBackup(backup);

      const meta = await storageService.getWorkspaceMeta();
      expect(meta.order).toEqual(['ws_exists']); // ws_missing not included
    });
  });

  // ── Round-trip test ─────────────────────────────────

  describe('round-trip', () => {
    it('export then import preserves all workspace data', async () => {
      // 1. Set up workspaces with bookmarks, shortcuts, pins
      const { personal, work } = await seedForBackup();
      const originalAll = workspaceService.getAll();
      expect(originalAll.length).toBe(2);

      // 2. Export backup
      const backup = await backupService.createBackup();
      expect(backup.meta.order.length).toBe(2);

      // 3. Wipe everything
      resetMocks();
      workspaceService._firstRunDelayMs = 0;
      await workspaceService.init(); // Creates a fresh default workspace

      // 4. Restore from backup
      await backupService.restoreBackup(backup);

      // 5. Re-init workspace service to pick up restored data
      await workspaceService.init();

      // 6. Verify workspaces
      const restoredAll = workspaceService.getAll();
      expect(restoredAll.length).toBe(2);

      const restoredPersonal = restoredAll[0];
      expect(restoredPersonal.name).toBe('Personal');
      expect(restoredPersonal.colorScheme).toBe('purple');

      const restoredWork = restoredAll[1];
      expect(restoredWork.name).toBe('Work');
      expect(restoredWork.colorScheme).toBe('blue');

      // 7. Verify bookmark tree for first workspace
      const personalChildren = await bookmarkService.getChildren(restoredPersonal.rootFolderId);
      const googleBm = personalChildren.find(c => c.url === 'https://google.com');
      expect(googleBm).toBeTruthy();

      const devFolder = personalChildren.find(c => c.title === 'Dev Resources');
      expect(devFolder).toBeTruthy();
      const devChildren = await bookmarkService.getChildren(devFolder.id);
      expect(devChildren.length).toBe(1);
      expect(devChildren[0].url).toBe('https://developer.mozilla.org');

      // 8. Verify bookmark tree for work workspace
      const workChildren = await bookmarkService.getChildren(restoredWork.rootFolderId);
      const githubBm = workChildren.find(c => c.url === 'https://github.com');
      expect(githubBm).toBeTruthy();

      // 9. Verify shortcuts preserved
      expect(restoredPersonal.shortcuts.length).toBe(1);
      expect(restoredPersonal.shortcuts[0].url).toBe('https://example.com');
    });
  });
});
