// Recursive bookmark tree renderer with expand/collapse
// Supports drag-and-drop reordering and subfolder creation

import { el, clearChildren } from '../utils/dom.js';
import { createBookmarkItem } from './bookmark-item.js';
import { showContextMenu } from './context-menu.js';
import { bookmarkService } from '../services/bookmark-service.js';
import { workspaceService } from '../services/workspace-service.js';
import { storageService } from '../services/storage-service.js';
import { bus, Events } from '../utils/event-bus.js';

export class BookmarkTree {
  /**
   * @param {HTMLElement} container - The DOM element to render into
   */
  constructor(container) {
    this.container = container;
    this.expandedFolders = new Set();
    this._unsubscribers = [];
    this._refreshing = false;     // Guard against concurrent refreshes
    this._pendingRefresh = false;  // Queue a refresh if one is in-flight
  }

  /**
   * Initialize the tree component.
   */
  async init() {
    // Load expanded folders state
    const uiState = await storageService.getUIState();
    const ws = workspaceService.getActive();
    if (ws && uiState.expandedFolders && uiState.expandedFolders[ws.id]) {
      this.expandedFolders = new Set(uiState.expandedFolders[ws.id]);
    }

    // Listen for events
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this.refresh()),
      bus.on(Events.TREE_REFRESH, () => this.refresh()),
      bus.on(Events.BOOKMARK_PINNED, () => this.refresh()),
      bus.on(Events.BOOKMARK_UNPINNED, () => this.refresh()),
      bus.on(Events.BOOKMARK_CHANGED, () => this.refresh()),
      bus.on(Events.BOOKMARK_REMOVED, () => this.refresh()),
    );

    // Listen for bookmark changes from service worker
    this._unsubBookmarks = bookmarkService.onMessage(() => this.refresh());

    // ── Make the container itself a root-level drop target ──
    this.container.addEventListener('dragover', (e) => {
      // Only respond if dragging over the container itself (not a folder item)
      if (e.target === this.container || e.target.closest('.empty-state')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.container.classList.add('drag-over-root');
      }
    });

    this.container.addEventListener('dragleave', (e) => {
      if (!this.container.contains(e.relatedTarget)) {
        this.container.classList.remove('drag-over-root');
      }
    });

    this.container.addEventListener('drop', (e) => {
      // Only handle drops on the container itself (not on folder items)
      // Folder items handle their own drops via e.stopPropagation()
      this.container.classList.remove('drag-over-root');
      const draggedId = e.dataTransfer.getData('text/plain');
      if (draggedId) {
        e.preventDefault();
        this._moveToRoot(draggedId);
      }
    });

    await this.refresh();
  }

  /**
   * Refresh the tree from the current workspace's bookmark folder.
   */
  async refresh() {
    // Guard: if a refresh is already running, queue one and return
    if (this._refreshing) {
      this._pendingRefresh = true;
      return;
    }
    this._refreshing = true;

    try {
      const ws = workspaceService.getActive();
      if (!ws) {
        this._renderEmpty('No workspace selected');
        return;
      }

      // Load expanded state for this workspace
      const uiState = await storageService.getUIState();
      if (uiState.expandedFolders && uiState.expandedFolders[ws.id]) {
        this.expandedFolders = new Set(uiState.expandedFolders[ws.id]);
      } else {
        this.expandedFolders = new Set();
      }

      const subtree = await bookmarkService.getSubTree(ws.rootFolderId);
      if (!subtree || subtree.length === 0) {
        this._renderEmpty('Folder not found');
        return;
      }

      const rootNode = subtree[0];
      const children = rootNode.children || [];

      // Filter out pinned items (they're shown in the pinned section)
      const pinnedIds = new Set(ws.pinnedBookmarkIds || []);
      const unpinnedChildren = children.filter(c => !pinnedIds.has(c.id));

      clearChildren(this.container);

      if (unpinnedChildren.length === 0) {
        this._renderEmpty('No bookmarks yet. Use the + button to add bookmarks.');
        return;
      }

      this._renderNodes(unpinnedChildren, 0);
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
   * Recursively render bookmark nodes.
   * @param {chrome.bookmarks.BookmarkTreeNode[]} nodes
   * @param {number} depth
   */
  _renderNodes(nodes, depth) {
    for (const node of nodes) {
      const isFolder = bookmarkService.isFolder(node);
      const isExpanded = this.expandedFolders.has(node.id);

      const item = createBookmarkItem(node, {
        depth,
        isExpanded,
        isPinned: false,
        onToggle: (id) => this._toggleFolder(id),
        onClick: (bm) => this._openBookmark(bm),
        onDrop: (draggedId, targetId) => this._moveBookmark(draggedId, targetId),
        onAddSubfolder: (parentId) => this._showSubfolderInput(parentId),
        onContextMenu: (n, pos) => this._showContextMenu(n, pos)
      });

      this.container.appendChild(item);

      // Render children if folder is expanded
      if (isFolder && isExpanded && node.children && node.children.length > 0) {
        this._renderNodes(node.children, depth + 1);
      }
    }
  }

  /**
   * Toggle a folder's expanded state.
   */
  async _toggleFolder(folderId) {
    if (this.expandedFolders.has(folderId)) {
      this.expandedFolders.delete(folderId);
    } else {
      this.expandedFolders.add(folderId);
    }

    // Persist expanded state
    const ws = workspaceService.getActive();
    if (ws) {
      const uiState = await storageService.getUIState();
      if (!uiState.expandedFolders) uiState.expandedFolders = {};
      uiState.expandedFolders[ws.id] = [...this.expandedFolders];
      await storageService.saveUIState(uiState);
    }

    await this.refresh();
  }

  /**
   * Open a bookmark in the current tab or a new tab.
   */
  _openBookmark(node) {
    if (node.url) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.update(tabs[0].id, { url: node.url });
        }
      });
    }
  }

  // ── Drag-and-Drop handlers ──────────────────────────

  /**
   * Move a bookmark/folder into a target folder.
   * @param {string} draggedId - ID of the dragged item
   * @param {string} targetFolderId - ID of the folder to drop into
   */
  async _moveBookmark(draggedId, targetFolderId) {
    try {
      // Guard: don't move a folder into its own subtree
      if (await this._isDescendant(draggedId, targetFolderId)) {
        return;
      }
      await bookmarkService.move(draggedId, { parentId: targetFolderId });
      // Auto-expand the target folder so user sees the result
      this.expandedFolders.add(targetFolderId);
      await this.refresh();
    } catch (err) {
      console.warn('Arc Spaces: move bookmark failed:', err);
    }
  }

  /**
   * Move a bookmark/folder to the workspace root folder.
   * @param {string} draggedId
   */
  async _moveToRoot(draggedId) {
    const ws = workspaceService.getActive();
    if (!ws) return;
    try {
      // Check if already at root
      const node = await bookmarkService.get(draggedId);
      if (node && node.parentId === ws.rootFolderId) return;
      await bookmarkService.move(draggedId, { parentId: ws.rootFolderId });
      await this.refresh();
    } catch (err) {
      console.warn('Arc Spaces: move to root failed:', err);
    }
  }

  /**
   * Check if potentialChild is a descendant of potentialParent.
   * Prevents moving a folder into its own subtree.
   */
  async _isDescendant(potentialParentId, potentialChildId) {
    if (potentialParentId === potentialChildId) return true;
    const subtree = await bookmarkService.getSubTree(potentialParentId);
    if (!subtree || subtree.length === 0) return false;

    const walk = (node) => {
      if (node.id === potentialChildId) return true;
      if (node.children) {
        return node.children.some(walk);
      }
      return false;
    };

    return walk(subtree[0]);
  }

  // ── Subfolder creation ──────────────────────────────

  /**
   * Show an inline text input after the folder item to create a subfolder.
   * @param {string} parentFolderId
   */
  _showSubfolderInput(parentFolderId) {
    // Remove any existing subfolder input
    const existing = this.container.querySelector('.subfolder-input-row');
    if (existing) existing.remove();

    // Find the folder item in the DOM
    const folderItem = this.container.querySelector(`[data-id="${parentFolderId}"]`);
    if (!folderItem) return;

    // Determine the depth from padding
    const currentPadding = parseInt(folderItem.style.paddingLeft, 10) || 12;
    const childPadding = currentPadding + 16;

    const inputRow = el('div', {
      className: 'bookmark-item subfolder-input-row',
      style: {
        paddingLeft: `${childPadding}px`
      }
    });

    // Folder icon
    const folderIcon = el('span', { className: 'item-icon folder-icon' });
    folderIcon.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 4C2 3.44772 2.44772 3 3 3H6.17157C6.43679 3 6.69114 3.10536 6.87868 3.29289L7.70711 4.12132C7.89464 4.30886 8.149 4.41421 8.41421 4.41421H13C13.5523 4.41421 14 4.86193 14 5.41421V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    inputRow.appendChild(folderIcon);

    const input = el('input', {
      className: 'subfolder-name-input',
      attrs: {
        type: 'text',
        placeholder: 'Folder name…',
        maxlength: '60'
      }
    });

    const commit = async () => {
      const name = input.value.trim();
      inputRow.remove();
      if (!name) return;
      try {
        await bookmarkService.create({ parentId: parentFolderId, title: name });
        // Auto-expand the parent so the new folder is visible
        this.expandedFolders.add(parentFolderId);
        await this.refresh();
      } catch (err) {
        console.warn('Arc Spaces: create subfolder failed:', err);
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      if (e.key === 'Escape') inputRow.remove();
    });

    input.addEventListener('blur', () => commit());

    inputRow.appendChild(input);

    // Insert after the folder item (or at the end if folder has expanded children)
    // Walk forward to find the last child of this folder at this depth level
    let insertAfter = folderItem;
    let next = folderItem.nextElementSibling;
    while (next) {
      const nextPadding = parseInt(next.style.paddingLeft, 10) || 0;
      if (nextPadding > currentPadding) {
        insertAfter = next;
        next = next.nextElementSibling;
      } else {
        break;
      }
    }

    insertAfter.insertAdjacentElement('afterend', inputRow);
    requestAnimationFrame(() => input.focus());
  }

  // ── Context Menu ─────────────────────────────────

  /**
   * Show context menu for a bookmark or folder.
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   * @param {{x: number, y: number}} pos
   */
  _showContextMenu(node, pos) {
    const isFolder = bookmarkService.isFolder(node);
    const isPinned = workspaceService.isPinned(node.id);

    const items = [];

    // Rename
    items.push({
      label: 'Rename',
      action: () => this._startInlineRename(node)
    });

    // Pin / Unpin
    if (isPinned) {
      items.push({
        label: 'Unpin',
        action: () => this._unpinItem(node.id)
      });
    } else {
      items.push({
        label: 'Pin to top',
        action: () => this._pinItem(node.id)
      });
    }

    // Open in new tab (bookmarks only)
    if (!isFolder && node.url) {
      items.push({
        label: 'Open in new tab',
        action: () => chrome.tabs.create({ url: node.url })
      });
    }

    // Separator before delete
    items.push({ separator: true });

    // Delete
    if (isFolder) {
      items.push({
        label: 'Delete folder',
        danger: true,
        action: () => this._deleteFolder(node)
      });
    } else {
      items.push({
        label: 'Delete',
        danger: true,
        action: () => this._deleteBookmark(node.id)
      });
    }

    showContextMenu({ x: pos.x, y: pos.y, items });
  }

  // ── Inline Rename ──────────────────────────────────

  /**
   * Replace the title of a bookmark/folder with an inline input for renaming.
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   */
  _startInlineRename(node) {
    const itemEl = this.container.querySelector(`[data-id="${node.id}"]`);
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
          console.warn('Arc Spaces: rename failed:', err);
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
        committed = true; // skip commit on blur
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

  // ── Delete ─────────────────────────────────────────

  /**
   * Delete a bookmark.
   * @param {string} bookmarkId
   */
  async _deleteBookmark(bookmarkId) {
    try {
      if (workspaceService.isPinned(bookmarkId)) {
        await workspaceService.unpinBookmark(bookmarkId);
      }
      await bookmarkService.remove(bookmarkId);
      bus.emit(Events.BOOKMARK_REMOVED, { id: bookmarkId });
      await this.refresh();
    } catch (err) {
      console.warn('Arc Spaces: delete bookmark failed:', err);
    }
  }

  /**
   * Delete a folder. Confirms if folder has contents.
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   */
  async _deleteFolder(node) {
    try {
      const children = await bookmarkService.getChildren(node.id);
      if (children.length > 0) {
        const confirmed = confirm(
          `Delete "${node.title}" and its ${children.length} item${children.length === 1 ? '' : 's'}?`
        );
        if (!confirmed) return;
      }

      // Unpin any pinned descendants before deleting
      const subtree = await bookmarkService.getSubTree(node.id);
      if (subtree && subtree.length > 0) {
        const walk = (n) => {
          if (workspaceService.isPinned(n.id)) {
            workspaceService.unpinBookmark(n.id);
          }
          if (n.children) n.children.forEach(walk);
        };
        walk(subtree[0]);
      }

      await bookmarkService.removeTree(node.id);
      bus.emit(Events.BOOKMARK_REMOVED, { id: node.id });
      await this.refresh();
    } catch (err) {
      console.warn('Arc Spaces: delete folder failed:', err);
    }
  }

  // ── Pin / Unpin ────────────────────────────────────

  async _pinItem(bookmarkId) {
    await workspaceService.pinBookmark(bookmarkId);
  }

  async _unpinItem(bookmarkId) {
    await workspaceService.unpinBookmark(bookmarkId);
  }

  /**
   * Render an empty state message.
   */
  _renderEmpty(message) {
    clearChildren(this.container);
    const empty = el('div', {
      className: 'empty-state',
      children: [
        el('p', { text: message, className: 'empty-message' })
      ]
    });
    this.container.appendChild(empty);
  }

  /**
   * Clean up event listeners.
   */
  destroy() {
    for (const unsub of this._unsubscribers) {
      unsub();
    }
    if (this._unsubBookmarks) this._unsubBookmarks();
  }
}
