// Pinned section — displays bookmarks pinned in the active workspace
// Supports right-click context menu for rename, unpin, delete
// Supports folder expand/collapse inline and drag-and-drop reordering

import { el, clearChildren } from '../utils/dom.js';
import { createBookmarkItem } from './bookmark-item.js';
import { showContextMenu } from './context-menu.js';
import { bookmarkService } from '../services/bookmark-service.js';
import { workspaceService } from '../services/workspace-service.js';
import { bus, Events } from '../utils/event-bus.js';

export class PinnedSection {
  /**
   * @param {HTMLElement} container
   */
  constructor(container) {
    this.container = container;
    this._unsubscribers = [];
    this._refreshing = false;     // Guard against concurrent refreshes
    this._pendingRefresh = false;  // Queue a refresh if one is in-flight
    this._expandedPinned = new Set(); // Track expanded pinned folders
  }

  async init() {
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this.refresh()),
      bus.on(Events.BOOKMARK_PINNED, () => this.refresh()),
      bus.on(Events.BOOKMARK_UNPINNED, () => this.refresh()),
      bus.on(Events.TREE_REFRESH, () => this.refresh()),
      bus.on(Events.BOOKMARK_CHANGED, () => this.refresh()),
      bus.on(Events.BOOKMARK_REMOVED, () => this.refresh()),
    );

    // Listen for external bookmark changes (edits/deletes from Chrome UI)
    this._unsubBookmarks = bookmarkService.onMessage(() => this.refresh());

    await this.refresh();
  }

  async refresh() {
    // Guard: if a refresh is already running, queue one and return
    if (this._refreshing) {
      this._pendingRefresh = true;
      return;
    }
    this._refreshing = true;

    try {
      clearChildren(this.container);

      const ws = workspaceService.getActive();
      if (!ws || !ws.pinnedBookmarkIds || ws.pinnedBookmarkIds.length === 0) {
        this.container.classList.add('hidden');
        return;
      }

      this.container.classList.remove('hidden');

      // Header
      const header = el('div', { className: 'section-header' });
      header.appendChild(el('span', { text: 'Pinned', className: 'section-label' }));
      this.container.appendChild(header);

      // Fetch pinned bookmarks
      const bookmarks = await bookmarkService.getMultiple(ws.pinnedBookmarkIds);

      const list = el('div', { className: 'pinned-list' });

      for (const bm of bookmarks) {
        const isFolder = !bm.url;
        const isExpanded = this._expandedPinned.has(bm.id);

        const item = createBookmarkItem(bm, {
          depth: 0,
          isExpanded,
          isPinned: true,
          onToggle: isFolder ? (id) => this._togglePinnedFolder(id) : undefined,
          onClick: (node) => this._handleClick(node),
          onContextMenu: (node, pos) => this._showContextMenu(node, pos)
        });
        list.appendChild(item);

        // Render children if pinned folder is expanded
        if (isFolder && isExpanded && bm.children && bm.children.length > 0) {
          this._renderChildren(bm.children, 1, list);
        }
      }

      this.container.appendChild(list);
    } finally {
      this._refreshing = false;
      // If a refresh was queued while we were running, do it now
      if (this._pendingRefresh) {
        this._pendingRefresh = false;
        this.refresh();
      }
    }
  }

  /**
   * Render child nodes of an expanded pinned folder.
   */
  _renderChildren(children, depth, list) {
    for (const child of children) {
      const isFolder = !child.url;
      const isExpanded = this._expandedPinned.has(child.id);

      const item = createBookmarkItem(child, {
        depth,
        isExpanded,
        isPinned: false, // Children aren't individually pinned
        onToggle: isFolder ? (id) => this._togglePinnedFolder(id) : undefined,
        onClick: (node) => this._handleClick(node),
        onContextMenu: (node, pos) => this._showContextMenu(node, pos)
      });
      list.appendChild(item);

      if (isFolder && isExpanded && child.children && child.children.length > 0) {
        this._renderChildren(child.children, depth + 1, list);
      }
    }
  }

  /**
   * Toggle a pinned folder's expanded state.
   */
  _togglePinnedFolder(folderId) {
    if (this._expandedPinned.has(folderId)) {
      this._expandedPinned.delete(folderId);
    } else {
      this._expandedPinned.add(folderId);
    }
    this.refresh();
  }

  /**
   * Handle click on a pinned item.
   * Folders toggle expand/collapse, bookmarks open in current tab.
   */
  _handleClick(node) {
    if (!node.url) {
      // Folder — toggle expand/collapse
      this._togglePinnedFolder(node.id);
    } else {
      // Bookmark — open in current tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, { url: node.url });
        }
      });
    }
  }

  // ── Context Menu ─────────────────────────────────

  /**
   * Show context menu for a pinned item.
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   * @param {{x: number, y: number}} pos
   */
  _showContextMenu(node, pos) {
    const isFolder = !node.url;
    const items = [];

    // Rename
    items.push({
      label: 'Rename',
      action: () => this._startInlineRename(node)
    });

    // Unpin (only for top-level pinned items)
    if (workspaceService.isPinned(node.id)) {
      items.push({
        label: 'Unpin',
        action: async () => {
          await workspaceService.unpinBookmark(node.id);
        }
      });
    }

    // Open in new tab (bookmarks only)
    if (!isFolder && node.url) {
      items.push({
        label: 'Open in new tab',
        action: () => chrome.tabs.create({ url: node.url })
      });
    }

    items.push({ separator: true });

    // Delete
    items.push({
      label: 'Delete',
      danger: true,
      action: async () => {
        if (workspaceService.isPinned(node.id)) {
          await workspaceService.unpinBookmark(node.id);
        }
        if (isFolder) {
          await bookmarkService.removeTree(node.id);
        } else {
          await bookmarkService.remove(node.id);
        }
        bus.emit(Events.BOOKMARK_REMOVED, { id: node.id });
      }
    });

    showContextMenu({ x: pos.x, y: pos.y, items });
  }

  // ── Inline Rename ──────────────────────────────────

  /**
   * Replace the title of a pinned item with an inline input for renaming.
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   */
  _startInlineRename(node) {
    const list = this.container.querySelector('.pinned-list');
    if (!list) return;

    const itemEl = list.querySelector(`[data-id="${node.id}"]`);
    if (!itemEl) return;

    const titleSpan = itemEl.querySelector('.item-title');
    if (!titleSpan) return;

    const input = el('input', {
      className: 'inline-rename-input',
      attrs: {
        type: 'text',
        value: node.title || '',
        maxlength: '120'
      }
    });

    titleSpan.replaceWith(input);

    let committed = false;
    const commit = async () => {
      if (committed) return;
      committed = true;
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== node.title) {
        try {
          await bookmarkService.update(node.id, { title: newTitle });
          bus.emit(Events.BOOKMARK_CHANGED, { id: node.id });
        } catch (err) {
          console.warn('Arc Spaces: rename pinned item failed:', err);
        }
      }
      await this.refresh();
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        committed = true;
        this.refresh();
      }
    });

    input.addEventListener('blur', () => commit());
    input.addEventListener('click', (e) => e.stopPropagation());

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  destroy() {
    for (const unsub of this._unsubscribers) {
      unsub();
    }
    if (this._unsubBookmarks) this._unsubBookmarks();
  }
}
