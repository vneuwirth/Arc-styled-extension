// Shortcut bar — website favicon icons for quick-launch bookmarks
// Each workspace has its own set of shortcut URLs displayed as circular icons

import { el, clearChildren } from '../utils/dom.js';
import { createFaviconImg } from '../utils/favicon.js';
import { workspaceService } from '../services/workspace-service.js';
import { showContextMenu } from './context-menu.js';
import { bus, Events } from '../utils/event-bus.js';

const ICON_PLUS = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
  <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

export class ShortcutBar {
  /**
   * @param {HTMLElement} container - The #shortcut-bar element
   */
  constructor(container) {
    this.container = container;
    this._unsubscribers = [];
  }

  init() {
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this.render()),
      bus.on(Events.SHORTCUT_ADDED, () => this.render()),
      bus.on(Events.SHORTCUT_REMOVED, () => this.render()),
    );
    this.render();
  }

  render() {
    clearChildren(this.container);

    const ws = workspaceService.getActive();
    if (!ws) return;

    const bar = el('div', { className: 'shortcut-bar' });
    const shortcuts = ws.shortcuts || [];

    // Render favicon icons for each shortcut
    for (const shortcut of shortcuts) {
      const icon = this._createShortcutIcon(shortcut);
      bar.appendChild(icon);
    }

    // "+" add button
    bar.appendChild(this._createAddButton());

    this.container.appendChild(bar);
  }

  _createShortcutIcon(shortcut) {
    const wrapper = el('button', {
      className: 'shortcut-icon',
      attrs: { title: shortcut.title || shortcut.url }
    });

    const img = createFaviconImg(shortcut.url, 20);
    wrapper.appendChild(img);

    // Fallback letter if favicon fails to load
    const fallback = el('span', {
      className: 'shortcut-icon-fallback',
      text: this._getInitial(shortcut.url)
    });
    wrapper.appendChild(fallback);

    // Click: navigate to URL
    wrapper.addEventListener('click', (e) => {
      e.preventDefault();
      this._openUrl(shortcut.url);
    });

    // Right-click: context menu to remove
    wrapper.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showContextMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Remove shortcut',
            danger: true,
            action: () => workspaceService.removeShortcut(shortcut.url),
          },
        ],
      });
    });

    return wrapper;
  }

  _createAddButton() {
    const btn = el('button', {
      className: 'shortcut-add-btn',
      attrs: { title: 'Add current tab as shortcut' }
    });
    btn.innerHTML = ICON_PLUS;
    btn.addEventListener('click', () => this._addCurrentTab());
    return btn;
  }

  async _openUrl(url) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      await chrome.tabs.update(tab.id, { url });
    }
  }

  async _addCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return;

    // Skip internal Chrome URLs
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

    await workspaceService.addShortcut(tab.url, tab.title || '');
  }

  /**
   * Get first letter of the domain for favicon fallback.
   */
  _getInitial(url) {
    try {
      const hostname = new URL(url).hostname;
      // Remove 'www.' prefix and take first letter
      return hostname.replace(/^www\./, '').charAt(0).toUpperCase();
    } catch {
      return '?';
    }
  }

  destroy() {
    for (const unsub of this._unsubscribers) unsub();
  }
}
