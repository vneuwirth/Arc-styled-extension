// Tests for the storage service

import { describe, it, expect, beforeEach } from 'vitest';
import { resetMocks } from './setup.js';
import { storageService } from '../sidepanel/services/storage-service.js';

describe('StorageService', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── Sync Storage ───────────────────────────────

  describe('getSync / setSync', () => {
    it('stores and retrieves sync data', async () => {
      await storageService.setSync({ testKey: 'testValue' });
      const result = await storageService.getSync('testKey');
      expect(result.testKey).toBe('testValue');
    });

    it('returns empty object on read failure', async () => {
      chrome.storage.sync.get.mockRejectedValueOnce(new Error('fail'));
      const result = await storageService.getSync('key');
      expect(result).toEqual({});
    });

    it('throws on write failure', async () => {
      chrome.storage.sync.set.mockRejectedValueOnce(new Error('quota exceeded'));
      await expect(storageService.setSync({ key: 'val' })).rejects.toThrow();
    });
  });

  // ── Local Storage ──────────────────────────────

  describe('getLocal / setLocal', () => {
    it('stores and retrieves local data', async () => {
      await storageService.setLocal({ uiState: { expanded: true } });
      const result = await storageService.getLocal('uiState');
      expect(result.uiState.expanded).toBe(true);
    });

    it('returns empty object on read failure', async () => {
      chrome.storage.local.get.mockRejectedValueOnce(new Error('fail'));
      const result = await storageService.getLocal('key');
      expect(result).toEqual({});
    });

    it('swallows write failures (non-critical)', async () => {
      chrome.storage.local.set.mockRejectedValueOnce(new Error('fail'));
      // Should NOT throw
      await storageService.setLocal({ key: 'val' });
    });
  });

  // ── Workspace Configs ──────────────────────────

  describe('getWorkspaces / saveWorkspaces', () => {
    it('returns null when no workspaces stored', async () => {
      const result = await storageService.getWorkspaces();
      expect(result).toBeNull();
    });

    it('round-trips workspace data', async () => {
      const workspaces = {
        activeWorkspaceId: 'ws1',
        order: ['ws1'],
        items: {
          ws1: { id: 'ws1', name: 'Personal', color: '#7C5CFC' },
        },
      };
      await storageService.saveWorkspaces(workspaces);
      const result = await storageService.getWorkspaces();
      expect(result.activeWorkspaceId).toBe('ws1');
      expect(result.items.ws1.name).toBe('Personal');
    });
  });

  // ── UI State ───────────────────────────────────

  describe('getUIState / saveUIState', () => {
    it('returns default UI state when empty', async () => {
      const state = await storageService.getUIState();
      expect(state).toEqual({ expandedFolders: {}, scrollPositions: {} });
    });

    it('round-trips UI state', async () => {
      await storageService.saveUIState({
        expandedFolders: { ws1: ['f1', 'f2'] },
        scrollPositions: { ws1: 100 },
      });
      const state = await storageService.getUIState();
      expect(state.expandedFolders.ws1).toEqual(['f1', 'f2']);
    });
  });

  // ── Synced Settings ──────────────────────────────

  describe('getSettings / saveSettings / updateSetting', () => {
    it('returns null when no settings stored', async () => {
      const settings = await storageService.getSettings();
      expect(settings).toBeNull();
    });

    it('round-trips settings via saveSettings', async () => {
      await storageService.saveSettings({ sidebarCompact: true, onboardingDismissed: false });
      const settings = await storageService.getSettings();
      expect(settings.sidebarCompact).toBe(true);
    });

    it('merges a single key with updateSetting', async () => {
      await storageService.saveSettings({ sidebarCompact: false, onboardingDismissed: false });
      await storageService.updateSetting('sidebarCompact', true);
      const settings = await storageService.getSettings();
      expect(settings.sidebarCompact).toBe(true);
      expect(settings.onboardingDismissed).toBe(false);
    });

    it('stores settings in sync storage (not local)', async () => {
      await storageService.updateSetting('sidebarCompact', true);
      const syncData = await chrome.storage.sync.get('settings');
      expect(syncData.settings.sidebarCompact).toBe(true);
      // Should NOT be in local storage
      const localData = await chrome.storage.local.get('settings');
      expect(localData.settings).toBeUndefined();
    });
  });

  // ── Sidebar Compact (synced) ────────────────────

  describe('getSidebarCompact / setSidebarCompact', () => {
    it('returns false by default', async () => {
      const compact = await storageService.getSidebarCompact();
      expect(compact).toBe(false);
    });

    it('persists compact state to sync storage', async () => {
      await storageService.setSidebarCompact(true);
      const compact = await storageService.getSidebarCompact();
      expect(compact).toBe(true);
    });

    it('returns false after setting back to false', async () => {
      await storageService.setSidebarCompact(true);
      await storageService.setSidebarCompact(false);
      const compact = await storageService.getSidebarCompact();
      expect(compact).toBe(false);
    });

    it('migrates from local storage on first read', async () => {
      // Simulate old version that stored in local
      await chrome.storage.local.set({ sidebarCompact: true });
      const compact = await storageService.getSidebarCompact();
      expect(compact).toBe(true);
      // After migration, should be in sync
      const syncData = await chrome.storage.sync.get('settings');
      expect(syncData.settings.sidebarCompact).toBe(true);
    });

    it('prefers sync over local when both exist', async () => {
      await chrome.storage.local.set({ sidebarCompact: true });
      await storageService.setSidebarCompact(false); // writes to sync
      const compact = await storageService.getSidebarCompact();
      expect(compact).toBe(false);
    });
  });

  // ── Onboarding (synced) ─────────────────────────

  describe('isOnboardingDismissed / dismissOnboarding', () => {
    it('returns false by default', async () => {
      const dismissed = await storageService.isOnboardingDismissed();
      expect(dismissed).toBe(false);
    });

    it('returns true after dismissing', async () => {
      await storageService.dismissOnboarding();
      const dismissed = await storageService.isOnboardingDismissed();
      expect(dismissed).toBe(true);
    });

    it('migrates from local storage on first read', async () => {
      // Simulate old version that stored in local
      await chrome.storage.local.set({ onboardingDismissed: true });
      const dismissed = await storageService.isOnboardingDismissed();
      expect(dismissed).toBe(true);
      // After migration, should be in sync
      const syncData = await chrome.storage.sync.get('settings');
      expect(syncData.settings.onboardingDismissed).toBe(true);
    });

    it('dismissOnboarding writes to sync (not local)', async () => {
      await storageService.dismissOnboarding();
      const syncData = await chrome.storage.sync.get('settings');
      expect(syncData.settings.onboardingDismissed).toBe(true);
    });
  });

  // ── arcSpacesRootId (local) ────────────────────

  describe('getArcSpacesRootIdLocal / saveArcSpacesRootIdLocal', () => {
    it('returns null when no root ID stored', async () => {
      const id = await storageService.getArcSpacesRootIdLocal();
      expect(id).toBeNull();
    });

    it('round-trips root ID via local storage', async () => {
      await storageService.saveArcSpacesRootIdLocal('101');
      const id = await storageService.getArcSpacesRootIdLocal();
      expect(id).toBe('101');
    });

    it('migrates from sync storage on first read', async () => {
      // Simulate old version that stored arcSpacesRootId in sync
      await chrome.storage.sync.set({ arcSpacesRootId: '42' });
      const id = await storageService.getArcSpacesRootIdLocal();
      expect(id).toBe('42');
      // After migration, should be in local storage too
      const localData = await chrome.storage.local.get('arcSpacesRootId');
      expect(localData.arcSpacesRootId).toBe('42');
    });

    it('stores root ID in local storage (not sync)', async () => {
      await storageService.saveArcSpacesRootIdLocal('200');
      const localData = await chrome.storage.local.get('arcSpacesRootId');
      expect(localData.arcSpacesRootId).toBe('200');
    });
  });

  // ── Split-Key Workspace Storage (v2) ────────────

  describe('getWorkspaceMeta / saveWorkspaceMeta', () => {
    it('returns null when no meta stored', async () => {
      const meta = await storageService.getWorkspaceMeta();
      expect(meta).toBeNull();
    });

    it('round-trips workspace metadata', async () => {
      const meta = { order: ['ws_default', 'ws_abc'], version: 2 };
      await storageService.saveWorkspaceMeta(meta);
      const result = await storageService.getWorkspaceMeta();
      expect(result.version).toBe(2);
      expect(result.order).toEqual(['ws_default', 'ws_abc']);
    });
  });

  describe('getWorkspaceItem / saveWorkspaceItem', () => {
    it('returns null when no item stored', async () => {
      const item = await storageService.getWorkspaceItem('ws_nonexistent');
      expect(item).toBeNull();
    });

    it('round-trips a workspace item', async () => {
      const ws = { id: 'ws_1', name: 'Work', color: '#3B82F6', shortcuts: [] };
      await storageService.saveWorkspaceItem('ws_1', ws);
      const result = await storageService.getWorkspaceItem('ws_1');
      expect(result.name).toBe('Work');
      expect(result.id).toBe('ws_1');
    });

    it('stores each workspace as its own sync key', async () => {
      await storageService.saveWorkspaceItem('ws_a', { id: 'ws_a', name: 'A' });
      await storageService.saveWorkspaceItem('ws_b', { id: 'ws_b', name: 'B' });
      const syncData = await chrome.storage.sync.get(['ws_a', 'ws_b']);
      expect(syncData.ws_a.name).toBe('A');
      expect(syncData.ws_b.name).toBe('B');
    });
  });

  describe('deleteWorkspaceItem', () => {
    it('removes a workspace item from sync', async () => {
      await storageService.saveWorkspaceItem('ws_del', { id: 'ws_del', name: 'Delete Me' });
      await storageService.deleteWorkspaceItem('ws_del');
      const result = await storageService.getWorkspaceItem('ws_del');
      expect(result).toBeNull();
    });
  });

  describe('getAllWorkspaceItems', () => {
    it('batch-fetches multiple workspace items', async () => {
      await storageService.saveWorkspaceItem('ws_x', { id: 'ws_x', name: 'X' });
      await storageService.saveWorkspaceItem('ws_y', { id: 'ws_y', name: 'Y' });
      const items = await storageService.getAllWorkspaceItems(['ws_x', 'ws_y']);
      expect(Object.keys(items)).toEqual(['ws_x', 'ws_y']);
      expect(items.ws_x.name).toBe('X');
      expect(items.ws_y.name).toBe('Y');
    });

    it('skips missing items gracefully', async () => {
      await storageService.saveWorkspaceItem('ws_exists', { id: 'ws_exists', name: 'Exists' });
      const items = await storageService.getAllWorkspaceItems(['ws_exists', 'ws_missing']);
      expect(Object.keys(items)).toEqual(['ws_exists']);
    });
  });

  describe('getWorkspaceLocal / saveWorkspaceLocal', () => {
    it('returns defaults when no local state stored', async () => {
      const local = await storageService.getWorkspaceLocal();
      expect(local).toEqual({ activeWorkspaceId: null, rootFolderIds: {} });
    });

    it('round-trips local workspace state', async () => {
      const state = {
        activeWorkspaceId: 'ws_default',
        rootFolderIds: { ws_default: '101', ws_work: '205' },
      };
      await storageService.saveWorkspaceLocal(state);
      const result = await storageService.getWorkspaceLocal();
      expect(result.activeWorkspaceId).toBe('ws_default');
      expect(result.rootFolderIds.ws_work).toBe('205');
    });
  });

  describe('deleteOldWorkspacesKey', () => {
    it('removes v1 "workspaces" key from sync', async () => {
      await storageService.saveWorkspaces({ order: ['ws1'], items: {} });
      await storageService.deleteOldWorkspacesKey();
      const result = await storageService.getWorkspaces();
      expect(result).toBeNull();
    });
  });

  // ── onChange ────────────────────────────────────

  describe('onChange', () => {
    it('subscribes and returns an unsubscribe function', () => {
      const cb = () => {};
      const unsub = storageService.onChange(cb);
      expect(chrome.storage.onChanged.addListener).toHaveBeenCalledWith(cb);

      unsub();
      expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledWith(cb);
    });
  });
});
