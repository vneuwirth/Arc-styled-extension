// Arc Spaces — Side Panel Orchestrator
// Initializes all components, manages lifecycle, coordinates workspace switching

import { workspaceService } from './services/workspace-service.js';
import { themeService } from './services/theme-service.js';
import { storageService } from './services/storage-service.js';
import { WorkspaceSwitcher } from './components/workspace-switcher.js';
import { ActionBar } from './components/action-bar.js';
import { ShortcutBar } from './components/shortcut-bar.js';
import { PinnedSection } from './components/pinned-section.js';
import { UnpinnedSection } from './components/unpinned-section.js';
import { bus, Events } from './utils/event-bus.js';

class App {
  constructor() {
    this.workspaceSwitcher = null;
    this.actionBar = null;
    this.shortcutBar = null;
    this.pinnedSection = null;
    this.unpinnedSection = null;
  }

  async init() {
    try {
      // Initialize workspace service (loads from storage or runs first-time setup)
      await workspaceService.init();

      // Apply the active workspace's theme
      const activeWs = workspaceService.getActive();
      if (activeWs) {
        themeService.apply(activeWs.colorScheme);
      }

      // Initialize UI components — new Arc-style container IDs
      this.workspaceSwitcher = new WorkspaceSwitcher(
        document.getElementById('space-bar')
      );
      await this.workspaceSwitcher.init();

      this.actionBar = new ActionBar(
        document.getElementById('workspace-header')
      );
      this.actionBar.init();

      this.shortcutBar = new ShortcutBar(
        document.getElementById('shortcut-bar')
      );
      this.shortcutBar.init();

      this.pinnedSection = new PinnedSection(
        document.getElementById('pinned-section')
      );
      await this.pinnedSection.init();

      this.unpinnedSection = new UnpinnedSection(
        document.getElementById('unpinned-section')
      );
      await this.unpinnedSection.init();

      // Listen for workspace changes to update the theme
      bus.on(Events.WORKSPACE_CHANGED, (ws) => {
        if (ws) themeService.apply(ws.colorScheme);
      });

      bus.on(Events.THEME_CHANGED, (ws) => {
        if (ws) themeService.apply(ws.colorScheme);
      });

      // Show onboarding hint if not dismissed
      await this._checkOnboarding();

      // Listen for storage changes from other devices
      this._syncing = false;
      storageService.onChange((changes, area) => {
        if (area === 'sync') {
          // Check for workspace changes (v2 split keys: ws_meta, ws_*)
          const hasWsChange = Object.keys(changes).some(
            key => key === 'ws_meta' || (key.startsWith('ws_') && key !== 'ws_local')
          );
          if (hasWsChange) {
            this._handleRemoteSync();
          }
          if (changes.settings) {
            // Another device updated settings — apply locally
            this._handleSettingsSync(changes.settings.newValue);
          }
        }
      });

    } catch (err) {
      console.error('Arc Spaces init error:', err);
      this._showError(err);
    }
  }

  _showError(err) {
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;
    mainContent.innerHTML = '';

    const errorDiv = document.createElement('div');
    errorDiv.className = 'empty-state';

    const msg = document.createElement('p');
    msg.className = 'empty-message';
    msg.textContent = 'Failed to initialize.';
    errorDiv.appendChild(msg);

    if (err) {
      const detail = document.createElement('p');
      detail.className = 'empty-message';
      detail.style.marginTop = '4px';
      detail.style.fontSize = '11px';
      detail.style.opacity = '0.7';
      detail.textContent = String(err.message || err).slice(0, 120);
      errorDiv.appendChild(detail);
    }

    const retryBtn = document.createElement('button');
    retryBtn.className = 'btn btn-primary btn-sm';
    retryBtn.textContent = 'Retry';
    retryBtn.style.marginTop = '12px';
    retryBtn.addEventListener('click', () => location.reload());
    errorDiv.appendChild(retryBtn);

    mainContent.appendChild(errorDiv);
  }

  async _checkOnboarding() {
    const dismissed = await storageService.isOnboardingDismissed();
    if (!dismissed) {
      const banner = document.getElementById('onboarding');
      if (banner) {
        banner.classList.remove('hidden');

        const dismissBtn = document.getElementById('onboarding-dismiss');
        if (dismissBtn) {
          dismissBtn.addEventListener('click', async () => {
            banner.classList.add('hidden');
            await storageService.dismissOnboarding();
          });
        }
      }
    }
  }

  _handleSettingsSync(newSettings) {
    if (!newSettings) return;

    // Update compact mode from remote
    const appBody = document.getElementById('app-body');
    if (appBody && newSettings.sidebarCompact !== undefined) {
      if (newSettings.sidebarCompact) {
        appBody.classList.add('compact');
      } else {
        appBody.classList.remove('compact');
      }
    }

    // Onboarding is one-way (once dismissed, stays dismissed)
    if (newSettings.onboardingDismissed) {
      const banner = document.getElementById('onboarding');
      if (banner) banner.classList.add('hidden');
    }
  }

  async _handleRemoteSync() {
    if (this._syncing) return; // Prevent re-entrant sync loops
    this._syncing = true;
    try {
      // Re-initialize workspace service with new data
      await workspaceService.init();
      const ws = workspaceService.getActive();
      if (ws) themeService.apply(ws.colorScheme);

      // Refresh all components
      bus.emit(Events.WORKSPACE_CHANGED, ws);
    } catch (err) {
      console.warn('Arc Spaces: remote sync refresh failed, will retry on next change:', err);
      // Don't show error UI — current state still works, just stale
    } finally {
      this._syncing = false;
    }
  }
}

// Start the app when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
