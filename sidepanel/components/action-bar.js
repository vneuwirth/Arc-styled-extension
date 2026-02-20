// Workspace header — shows active workspace name + quick-action buttons
// Replaces the old action-bar with navigation buttons.

import { el, clearChildren } from '../utils/dom.js';
import { bookmarkService } from '../services/bookmark-service.js';
import { workspaceService } from '../services/workspace-service.js';
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

    // Workspace name (left side)
    const name = el('span', {
      className: 'workspace-header-name',
      text: ws.name,
      style: { color: ws.color }
    });
    bar.appendChild(name);

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
