// Unpinned section — wrapper with header label around the bookmark tree

import { el } from '../utils/dom.js';
import { BookmarkTree } from './bookmark-tree.js';
import { workspaceService } from '../services/workspace-service.js';
import { bus, Events } from '../utils/event-bus.js';

export class UnpinnedSection {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    this.tree = null;
    this._unsubscribers = [];
  }

  async init() {
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this._updateHeader()),
    );

    this._render();
    await this.tree.init();
  }

  _render() {
    // Header
    const header = el('div', { className: 'section-header' });
    header.appendChild(el('span', { text: 'Bookmarks', className: 'section-label' }));
    this.container.appendChild(header);

    // Divider
    this.container.appendChild(el('div', { className: 'section-divider' }));

    // Tree container
    const treeContainer = el('div', { className: 'bookmark-tree-container' });
    this.container.appendChild(treeContainer);

    this.tree = new BookmarkTree(treeContainer);
  }

  _updateHeader() {
    const label = this.container.querySelector('.section-label');
    if (label) {
      const ws = workspaceService.getActive();
      label.textContent = ws ? 'Bookmarks' : 'No workspace';
    }
  }

  destroy() {
    for (const unsub of this._unsubscribers) {
      unsub();
    }
    if (this.tree) this.tree.destroy();
  }
}
