// Workspace header — shows active workspace name + quick-action buttons
// Replaces the old action-bar with navigation buttons.

import { el, clearChildren } from '../utils/dom.js';
import { bookmarkService } from '../services/bookmark-service.js';
import { workspaceService } from '../services/workspace-service.js';
import { themeService } from '../services/theme-service.js';
import { showContextMenu } from './context-menu.js';
import { bus, Events } from '../utils/event-bus.js';

export class ActionBar {
  /**
   * @param {HTMLElement} container - The #workspace-header element
   */
  constructor(container) {
    this.container = container;
    this._unsubscribers = [];
  }

  init() {
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this.render()),
      bus.on(Events.WORKSPACE_RENAMED, () => this.render()),
    );

    this.render();
  }

  render() {
    clearChildren(this.container);

    const ws = workspaceService.getActive();
    if (!ws) return;

    const bar = el('div', { className: 'workspace-header-bar' });

    // Workspace name (left side) — clickable to show workspace menu
    const nameGroup = el('div', {
      className: 'workspace-header-name-group',
      events: {
        click: (e) => {
          e.stopPropagation();
          this._showWorkspaceMenu(ws, e);
        }
      }
    });

    const name = el('span', {
      className: 'workspace-header-name',
      text: ws.name,
      style: { color: ws.color }
    });
    nameGroup.appendChild(name);

    // "▾" dropdown indicator
    const chevron = el('span', {
      className: 'workspace-header-chevron',
      text: '▾',
      style: { color: ws.color }
    });
    nameGroup.appendChild(chevron);

    bar.appendChild(nameGroup);

    // Add bookmark button
    bar.appendChild(this._createButton('Add current tab', `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 2H12V14L8 11L4 14V2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>`, () => this._addBookmark()));

    // Add folder button
    bar.appendChild(this._createButton('New folder', `
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M2 4C2 3.44772 2.44772 3 3 3H6.17157C6.43679 3 6.69114 3.10536 6.87868 3.29289L7.70711 4.12132C7.89464 4.30886 8.149 4.41421 8.41421 4.41421H13C13.5523 4.41421 14 4.86193 14 5.41421V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        <path d="M8 7V11M6 9H10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>`, () => this._addFolder()));

    this.container.appendChild(bar);
  }

  _createButton(title, svgHtml, onClick) {
    const btn = el('button', {
      className: 'action-btn',
      attrs: { title }
    });
    btn.innerHTML = svgHtml;
    btn.addEventListener('click', onClick);
    return btn;
  }

  _showWorkspaceMenu(ws, e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = [];

    // Rename
    items.push({
      label: 'Rename workspace',
      action: () => this._startRename(ws)
    });

    // Change Color — submenu-style with color swatches
    for (const c of workspaceService.colors) {
      // We'll add all colors as a submenu via a single "Change color…" item
    }
    items.push({
      label: 'Change color…',
      action: () => this._showColorMenu(ws, rect)
    });

    items.push({ separator: true });

    // Delete (only if more than 1 workspace)
    if (workspaceService.getAll().length > 1) {
      items.push({
        label: 'Delete workspace',
        danger: true,
        action: async () => {
          const confirmed = confirm(`Delete workspace "${ws.name}"? Its bookmarks will also be removed.`);
          if (confirmed) {
            await workspaceService.delete(ws.id);
          }
        }
      });
    }

    items.push({ separator: true });

    // Debug: show sync storage info
    items.push({
      label: 'Sync debug info',
      action: async () => {
        const allSync = await chrome.storage.sync.get(null);
        const extId = chrome.runtime?.id || 'unknown';
        const keys = Object.keys(allSync);
        const wsKeys = keys.filter(k => k.startsWith('ws_'));
        const totalSize = JSON.stringify(allSync).length;
        alert(
          `Extension ID: ${extId}\n` +
          `Sync keys (${keys.length}): ${keys.join(', ')}\n` +
          `Workspace keys: ${wsKeys.join(', ')}\n` +
          `Total sync size: ${totalSize} bytes\n` +
          `ws_meta: ${JSON.stringify(allSync.ws_meta || 'not found')}`
        );
      }
    });

    showContextMenu({ x: rect.left, y: rect.bottom + 4, items });
  }

  _showColorMenu(ws, fromRect) {
    const colors = workspaceService.colors;
    const items = colors.map(c => ({
      label: `${c.name === ws.colorScheme ? '● ' : '  '}${c.name.charAt(0).toUpperCase() + c.name.slice(1)}`,
      action: async () => {
        await workspaceService.changeColor(ws.id, c.name);
        if (ws.id === workspaceService.getActive()?.id) {
          themeService.apply(c.name);
        }
        this.render();
      }
    }));
    showContextMenu({ x: fromRect.left, y: fromRect.bottom + 4, items });
  }

  _startRename(ws) {
    // Replace the workspace name in the header with an inline input
    const nameGroup = this.container.querySelector('.workspace-header-name-group');
    if (!nameGroup) return;

    const input = el('input', {
      className: 'workspace-rename-input inline-header-rename',
      attrs: {
        type: 'text',
        value: ws.name,
        maxlength: '30'
      },
      style: { color: ws.color }
    });

    clearChildren(nameGroup);
    nameGroup.appendChild(input);

    // Stop clicks on input from re-opening the menu
    input.addEventListener('click', (e) => e.stopPropagation());

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newName = input.value.trim();
      if (newName && newName !== ws.name) {
        await workspaceService.rename(ws.id, newName);
      }
      this.render();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); committed = true; this.render(); }
    });
    input.addEventListener('blur', () => commit());

    requestAnimationFrame(() => { input.focus(); input.select(); });
  }

  async _addBookmark() {
    const ws = workspaceService.getActive();
    if (!ws) return;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    await bookmarkService.create({
      parentId: ws.rootFolderId,
      title: tab.title || 'Untitled',
      url: tab.url
    });

    bus.emit(Events.TREE_REFRESH);
  }

  async _addFolder() {
    const ws = workspaceService.getActive();
    if (!ws) return;

    // Create an inline folder-name input at the top of #main-content
    const mainContent = document.getElementById('main-content');
    if (!mainContent) return;

    // Remove any existing inline input
    const existing = mainContent.querySelector('.inline-folder-input');
    if (existing) existing.remove();

    const wrapper = el('div', {
      className: 'inline-folder-input',
      style: { padding: '4px 12px' }
    });

    const input = el('input', {
      className: 'workspace-create-input',
      attrs: {
        type: 'text',
        placeholder: 'Folder name…',
        maxlength: '60'
      }
    });

    const finish = async (save) => {
      const name = input.value.trim();
      wrapper.remove();
      if (save && name) {
        await bookmarkService.create({
          parentId: ws.rootFolderId,
          title: name
        });
        bus.emit(Events.TREE_REFRESH);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));

    wrapper.appendChild(input);
    mainContent.insertBefore(wrapper, mainContent.firstChild);
    requestAnimationFrame(() => input.focus());
  }

  destroy() {
    for (const unsub of this._unsubscribers) {
      unsub();
    }
  }
}
