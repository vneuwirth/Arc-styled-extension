// Unified wrapper around chrome.storage
// Routes data to sync (workspace configs) or local (UI state) as appropriate

class StorageService {
  /**
   * Get values from sync storage.
   * @param {string|string[]} keys
   * @returns {Promise<Object>}
   */
  async getSync(keys) {
    try {
      return await chrome.storage.sync.get(keys);
    } catch (err) {
      console.warn('Arc Spaces: sync storage read failed, falling back to empty:', err);
      return {};
    }
  }

  /**
   * Set values in sync storage.
   * @param {Object} data
   */
  async setSync(data) {
    try {
      return await chrome.storage.sync.set(data);
    } catch (err) {
      console.warn('Arc Spaces: sync storage write failed:', err);
      throw err; // Re-throw — callers should know writes failed
    }
  }

  /**
   * Get values from local storage.
   * @param {string|string[]} keys
   * @returns {Promise<Object>}
   */
  async getLocal(keys) {
    try {
      return await chrome.storage.local.get(keys);
    } catch (err) {
      console.warn('Arc Spaces: local storage read failed, falling back to empty:', err);
      return {};
    }
  }

  /**
   * Set values in local storage.
   * @param {Object} data
   */
  async setLocal(data) {
    try {
      return await chrome.storage.local.set(data);
    } catch (err) {
      console.warn('Arc Spaces: local storage write failed:', err);
      // Don't re-throw — local writes are for UI state, not critical
    }
  }

  /**
   * Get workspace configs from sync storage.
   * @returns {Promise<{activeWorkspaceId: string, order: string[], items: Object}>}
   */
  async getWorkspaces() {
    const { workspaces } = await this.getSync('workspaces');
    return workspaces || null;
  }

  /**
   * Save workspace configs to sync storage.
   * @param {Object} workspaces
   */
  async saveWorkspaces(workspaces) {
    return this.setSync({ workspaces });
  }

  /**
   * Get the root "Arc Spaces" folder ID from sync storage.
   * @deprecated Use getArcSpacesRootIdLocal() — arcSpacesRootId is a device-local bookmark ID.
   * Kept for backward-compat migration from older versions that stored this in sync.
   * @returns {Promise<string|null>}
   */
  async getArcSpacesRootId() {
    const { arcSpacesRootId } = await this.getSync('arcSpacesRootId');
    return arcSpacesRootId || null;
  }

  /**
   * Get the root "Arc Spaces" folder ID from local storage.
   * Bookmark folder IDs are device-local and should NOT be synced.
   * Falls back to sync storage for migration from older versions.
   * @returns {Promise<string|null>}
   */
  async getArcSpacesRootIdLocal() {
    // Try local first
    const { arcSpacesRootId } = await this.getLocal('arcSpacesRootId');
    if (arcSpacesRootId) return arcSpacesRootId;
    // Migrate from sync (older versions stored this in sync)
    const syncId = await this.getArcSpacesRootId();
    if (syncId) {
      await this.saveArcSpacesRootIdLocal(syncId);
    }
    return syncId;
  }

  /**
   * Save the root "Arc Spaces" folder ID to local storage.
   * @param {string} id
   */
  async saveArcSpacesRootIdLocal(id) {
    return this.setLocal({ arcSpacesRootId: id });
  }

  /**
   * Get UI state from local storage.
   * @returns {Promise<Object>}
   */
  async getUIState() {
    const { uiState } = await this.getLocal('uiState');
    return uiState || { expandedFolders: {}, scrollPositions: {} };
  }

  /**
   * Save UI state to local storage.
   * @param {Object} uiState
   */
  async saveUIState(uiState) {
    return this.setLocal({ uiState });
  }

  // ── Synced Settings ─────────────────────────────────
  // Settings that should sync across devices are stored in a unified
  // `settings` object in chrome.storage.sync. Methods below read from
  // sync first, then fall back to local storage for backward-compat
  // migration from older versions that stored these values locally.

  /**
   * Get all synced settings.
   * Returns null if no settings have been saved yet (for migration detection).
   * @returns {Promise<Object|null>}
   */
  async getSettings() {
    const { settings } = await this.getSync('settings');
    return settings || null;
  }

  /**
   * Save all synced settings.
   * @param {Object} settings
   */
  async saveSettings(settings) {
    return this.setSync({ settings });
  }

  /**
   * Update a single synced setting (merges with existing).
   * @param {string} key
   * @param {*} value
   */
  async updateSetting(key, value) {
    const settings = await this.getSettings() || {};
    settings[key] = value;
    return this.saveSettings(settings);
  }

  /**
   * Get onboarding dismissed state.
   * Reads from sync settings, falls back to local for migration.
   * @returns {Promise<boolean>}
   */
  async isOnboardingDismissed() {
    const settings = await this.getSettings();
    if (settings && settings.onboardingDismissed !== undefined) {
      return settings.onboardingDismissed === true;
    }
    // Fallback: check local storage for pre-migration value
    const { onboardingDismissed } = await this.getLocal('onboardingDismissed');
    if (onboardingDismissed) {
      // Migrate to sync
      await this.updateSetting('onboardingDismissed', true);
      return true;
    }
    return false;
  }

  /**
   * Dismiss onboarding (syncs across devices).
   */
  async dismissOnboarding() {
    return this.updateSetting('onboardingDismissed', true);
  }

  /**
   * Get sidebar compact state.
   * Reads from sync settings, falls back to local for migration.
   * @returns {Promise<boolean>}
   */
  async getSidebarCompact() {
    const settings = await this.getSettings();
    if (settings && settings.sidebarCompact !== undefined) {
      return settings.sidebarCompact === true;
    }
    // Fallback: check local storage for pre-migration value
    const { sidebarCompact } = await this.getLocal('sidebarCompact');
    if (sidebarCompact !== undefined) {
      // Migrate to sync
      await this.updateSetting('sidebarCompact', sidebarCompact);
      return sidebarCompact === true;
    }
    return false;
  }

  /**
   * Set sidebar compact state (syncs across devices).
   * @param {boolean} compact
   */
  async setSidebarCompact(compact) {
    return this.updateSetting('sidebarCompact', compact);
  }

  // ── Split-Key Workspace Storage (v2) ────────────────────
  // Each workspace is stored as its own sync key to stay under 8KB per-item limit.
  // Workspace order/version stored in ws_meta. Device-local state in ws_local.

  /**
   * Get workspace metadata (order + version) from sync storage.
   * @returns {Promise<{order: string[], version: number}|null>}
   */
  async getWorkspaceMeta() {
    const { ws_meta } = await this.getSync('ws_meta');
    return ws_meta || null;
  }

  /**
   * Save workspace metadata to sync storage.
   * @param {{order: string[], version: number}} meta
   */
  async saveWorkspaceMeta(meta) {
    return this.setSync({ ws_meta: meta });
  }

  /**
   * Get a single workspace item from sync storage.
   * @param {string} wsId - Workspace ID (also used as sync key)
   * @returns {Promise<Object|null>}
   */
  async getWorkspaceItem(wsId) {
    const result = await this.getSync(wsId);
    return result[wsId] || null;
  }

  /**
   * Save a single workspace item to sync storage.
   * @param {string} wsId
   * @param {Object} data
   */
  async saveWorkspaceItem(wsId, data) {
    return this.setSync({ [wsId]: data });
  }

  /**
   * Delete a workspace item from sync storage.
   * @param {string} wsId
   */
  async deleteWorkspaceItem(wsId) {
    try {
      await chrome.storage.sync.remove(wsId);
    } catch (err) {
      console.warn('Arc Spaces: failed to delete workspace item from sync:', err);
    }
  }

  /**
   * Batch-fetch all workspace items from sync storage.
   * @param {string[]} order - Array of workspace IDs to fetch
   * @returns {Promise<Object>} Map of wsId → workspace data
   */
  async getAllWorkspaceItems(order) {
    const result = await this.getSync(order);
    const items = {};
    for (const wsId of order) {
      if (result[wsId]) items[wsId] = result[wsId];
    }
    return items;
  }

  /**
   * Get device-local workspace state (activeWorkspaceId, rootFolderIds).
   * @returns {Promise<{activeWorkspaceId: string|null, rootFolderIds: Object}>}
   */
  async getWorkspaceLocal() {
    const { ws_local } = await this.getLocal('ws_local');
    return ws_local || { activeWorkspaceId: null, rootFolderIds: {} };
  }

  /**
   * Save device-local workspace state.
   * @param {{activeWorkspaceId: string, rootFolderIds: Object}} data
   */
  async saveWorkspaceLocal(data) {
    return this.setLocal({ ws_local: data });
  }

  /**
   * Delete old v1 "workspaces" key from sync storage (migration cleanup).
   */
  async deleteOldWorkspacesKey() {
    try {
      await chrome.storage.sync.remove('workspaces');
    } catch (err) {
      console.warn('Arc Spaces: failed to delete old workspaces key:', err);
    }
  }

  /**
   * Listen for storage changes.
   * @param {Function} callback - Called with (changes, areaName)
   * @returns {Function} Unsubscribe function
   */
  onChange(callback) {
    chrome.storage.onChanged.addListener(callback);
    return () => chrome.storage.onChanged.removeListener(callback);
  }
}

export const storageService = new StorageService();
