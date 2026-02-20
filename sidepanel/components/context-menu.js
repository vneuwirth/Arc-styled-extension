// Context menu — lightweight floating menu for bookmark/folder actions
// Singleton: only one context menu can be open at a time

import { el } from '../utils/dom.js';

let activeMenu = null;
let outsideClickHandler = null;
let escapeHandler = null;

/**
 * Show a context menu at the given position.
 * @param {Object} opts
 * @param {number} opts.x - Left position (px)
 * @param {number} opts.y - Top position (px)
 * @param {Array<{label: string, danger?: boolean, separator?: boolean, action: Function}>} opts.items
 */
export function showContextMenu({ x, y, items }) {
  closeContextMenu();

  const menu = el('div', { className: 'context-menu' });

  for (const item of items) {
    if (item.separator) {
      menu.appendChild(el('div', { className: 'context-menu-separator' }));
      continue;
    }

    const row = el('div', {
      className: [
        'context-menu-item',
        item.danger ? 'context-menu-item-danger' : ''
      ],
      text: item.label,
      events: {
        click: (e) => {
          e.stopPropagation();
          closeContextMenu();
          item.action();
        }
      }
    });

    menu.appendChild(row);
  }

  // Position the menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  // Clamp to viewport bounds after rendering (so we know dimensions)
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 4}px`;
    }
  });

  activeMenu = menu;

  // Close on outside click (deferred to avoid catching the triggering right-click)
  requestAnimationFrame(() => {
    outsideClickHandler = (e) => {
      if (activeMenu && !activeMenu.contains(e.target)) {
        closeContextMenu();
      }
    };
    document.addEventListener('click', outsideClickHandler, true);
    document.addEventListener('contextmenu', outsideClickHandler, true);
  });

  // Close on Escape
  escapeHandler = (e) => {
    if (e.key === 'Escape') closeContextMenu();
  };
  document.addEventListener('keydown', escapeHandler);
}

/**
 * Close the active context menu if any.
 */
export function closeContextMenu() {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
  if (outsideClickHandler) {
    document.removeEventListener('click', outsideClickHandler, true);
    document.removeEventListener('contextmenu', outsideClickHandler, true);
    outsideClickHandler = null;
  }
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    escapeHandler = null;
  }
}
