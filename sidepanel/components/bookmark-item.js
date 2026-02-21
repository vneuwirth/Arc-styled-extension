// Renders a single bookmark (favicon + title) or folder (icon + title + chevron)
// Supports drag-and-drop (draggable source + folder drop targets)
// Supports subfolder creation via hover "+" button on folders

import { el } from '../utils/dom.js';
import { createFaviconImg } from '../utils/favicon.js';

/**
 * Create a bookmark item element.
 * @param {chrome.bookmarks.BookmarkTreeNode} node
 * @param {Object} opts
 * @param {number} opts.depth - Nesting depth for indentation
 * @param {boolean} opts.isExpanded - Whether folder is expanded
 * @param {boolean} opts.isPinned - Whether item is pinned
 * @param {Function} opts.onToggle - Called when folder chevron is clicked
 * @param {Function} opts.onClick - Called when item is clicked
 * @param {Function} [opts.onDrop] - Called with (draggedId, targetFolderId) when a drop occurs
 * @param {Function} [opts.onAddSubfolder] - Called with (parentFolderId) to create a subfolder
 * @param {Function} [opts.onContextMenu] - Called with (node, {x, y}) on right-click
 * @returns {HTMLElement}
 */
export function createBookmarkItem(node, opts = {}) {
  const { depth = 0, isExpanded = false, isPinned = false, onToggle, onClick, onDrop, onDropBetween, onAddSubfolder, onContextMenu } = opts;
  const isFolder = !node.url;

  const item = el('div', {
    className: [
      'bookmark-item',
      isFolder ? 'bookmark-folder' : 'bookmark-link',
      isExpanded ? 'expanded' : '',
      isPinned ? 'pinned' : ''
    ],
    dataset: {
      id: node.id,
      type: isFolder ? 'folder' : 'bookmark'
    },
    style: {
      paddingLeft: `${12 + depth * 16}px`
    }
  });

  // ── Make item draggable ──────────────────────────
  item.draggable = true;

  item.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', node.id);
    e.dataTransfer.effectAllowed = 'move';
    // Add dragging class after a microtask so the browser captures the element first
    requestAnimationFrame(() => item.classList.add('dragging'));
  });

  item.addEventListener('dragend', () => {
    item.classList.remove('dragging');
  });

  // ── Make items drop targets (zone-based detection) ──
  if (onDrop || onDropBetween) {
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';

      // Clear previous drop indicator classes
      item.classList.remove('drag-over', 'drop-before', 'drop-after');

      const rect = item.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const height = rect.height;

      if (isFolder) {
        // Folders: 3-zone — top 25% insert before, middle 50% drop into, bottom 25% insert after
        if (y < height * 0.25) {
          item.classList.add('drop-before');
        } else if (y > height * 0.75) {
          item.classList.add('drop-after');
        } else {
          item.classList.add('drag-over');
        }
      } else {
        // Bookmarks: 2-zone — top 50% insert before, bottom 50% insert after
        if (y < height * 0.5) {
          item.classList.add('drop-before');
        } else {
          item.classList.add('drop-after');
        }
      }
    });

    item.addEventListener('dragleave', (e) => {
      if (!item.contains(e.relatedTarget)) {
        item.classList.remove('drag-over', 'drop-before', 'drop-after');
      }
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const draggedId = e.dataTransfer.getData('text/plain');

      if (!draggedId || draggedId === node.id) {
        item.classList.remove('drag-over', 'drop-before', 'drop-after');
        return;
      }

      if (item.classList.contains('drag-over') && isFolder && onDrop) {
        // Drop INTO folder (existing behavior)
        onDrop(draggedId, node.id);
      } else if (item.classList.contains('drop-before') && onDropBetween) {
        onDropBetween(draggedId, node.id, 'before');
      } else if (item.classList.contains('drop-after') && onDropBetween) {
        onDropBetween(draggedId, node.id, 'after');
      }

      item.classList.remove('drag-over', 'drop-before', 'drop-after');
    });
  }

  // Chevron for folders
  if (isFolder) {
    const chevron = el('span', {
      className: ['chevron', isExpanded ? 'chevron-expanded' : ''],
      events: {
        click: (e) => {
          e.stopPropagation();
          if (onToggle) onToggle(node.id);
        }
      }
    });
    // Inline SVG chevron for instant rendering (no fetch delay)
    chevron.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    item.appendChild(chevron);
  } else {
    // Spacer for alignment when not a folder
    item.appendChild(el('span', { className: 'chevron-spacer' }));
  }

  // Icon
  if (isFolder) {
    const folderIcon = el('span', { className: 'item-icon folder-icon' });
    folderIcon.innerHTML = isExpanded
      ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 4C2 3.44772 2.44772 3 3 3H6.17157C6.43679 3 6.69114 3.10536 6.87868 3.29289L7.70711 4.12132C7.89464 4.30886 8.149 4.41421 8.41421 4.41421H13C13.5523 4.41421 14 4.86193 14 5.41421V6H2V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M2 6H13.5L12.5 13H3L2 6Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>`
      : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M2 4C2 3.44772 2.44772 3 3 3H6.17157C6.43679 3 6.69114 3.10536 6.87868 3.29289L7.70711 4.12132C7.89464 4.30886 8.149 4.41421 8.41421 4.41421H13C13.5523 4.41421 14 4.86193 14 5.41421V12C14 12.5523 13.5523 13 13 13H3C2.44772 13 2 12.5523 2 12V4Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>`;
    item.appendChild(folderIcon);
  } else {
    // Favicon for bookmarks
    const faviconWrapper = el('span', { className: 'item-icon' });
    const img = createFaviconImg(node.url, 16);
    faviconWrapper.appendChild(img);

    // Fallback globe icon if favicon fails
    const fallback = el('span', { className: 'favicon-fallback' });
    fallback.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>
      <ellipse cx="8" cy="8" rx="3" ry="6" stroke="currentColor" stroke-width="1.5"/>
      <path d="M2 8H14" stroke="currentColor" stroke-width="1.5"/>
    </svg>`;
    faviconWrapper.appendChild(fallback);
    item.appendChild(faviconWrapper);
  }

  // Title
  const title = el('span', {
    className: 'item-title',
    text: node.title || (isFolder ? 'Untitled Folder' : new URL(node.url).hostname)
  });
  item.appendChild(title);

  // Pin indicator
  if (isPinned) {
    const pinBadge = el('span', { className: 'pin-badge' });
    pinBadge.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <circle cx="8" cy="8" r="4"/>
    </svg>`;
    item.appendChild(pinBadge);
  }

  // ── Subfolder "+" button (folders only, visible on hover) ──
  if (isFolder && onAddSubfolder) {
    const addSubBtn = el('button', {
      className: 'subfolder-add',
      attrs: { title: 'New subfolder', type: 'button' },
      events: {
        click: (e) => {
          e.stopPropagation();
          onAddSubfolder(node.id);
        }
      }
    });
    addSubBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
    item.appendChild(addSubBtn);
  }

  // Click handler
  item.addEventListener('click', () => {
    if (isFolder) {
      if (onToggle) onToggle(node.id);
    } else {
      if (onClick) onClick(node);
    }
  });

  // Right-click context menu
  if (onContextMenu) {
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(node, { x: e.clientX, y: e.clientY });
    });
  }

  return item;
}
