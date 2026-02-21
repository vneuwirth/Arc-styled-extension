// Context menu — lightweight floating menu for bookmark/folder actions
// Singleton: only one context menu can be open at a time

import { el } from '../utils/dom.js';

let activeMenu = null;
let activeSubmenu = null;   // { element, row } — body-appended submenu
let outsideClickHandler = null;
let escapeHandler = null;

/**
 * Hide and remove the body-appended submenu (if any).
 */
function _hideActiveSubmenu() {
  if (activeSubmenu) {
    activeSubmenu.element.classList.remove('context-submenu-visible');
    if (activeSubmenu.element.parentNode) {
      activeSubmenu.element.remove();
    }
    activeSubmenu = null;
  }
}

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

    // ── Submenu item (has children) ──────────────
    if (item.children && item.children.length > 0) {
      const row = el('div', {
        className: 'context-menu-item context-menu-item-submenu',
      });

      row.appendChild(el('span', { text: item.label }));

      const chevron = el('span', { className: 'context-menu-submenu-chevron' });
      chevron.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none">
        <path d="M6 3L11 8L6 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
      row.appendChild(chevron);

      // Build flyout submenu (NOT appended to row — will be appended to body on hover)
      const submenu = el('div', { className: 'context-submenu' });
      for (const child of item.children) {
        if (child.separator) {
          submenu.appendChild(el('div', { className: 'context-menu-separator' }));
          continue;
        }
        submenu.appendChild(el('div', {
          className: [
            'context-menu-item',
            child.danger ? 'context-menu-item-danger' : ''
          ],
          text: child.label,
          events: {
            click: (e) => {
              e.stopPropagation();
              closeContextMenu();
              child.action();
            }
          }
        }));
      }

      // Show submenu on hover — append to body with fixed positioning
      row.addEventListener('mouseenter', () => {
        _hideActiveSubmenu();

        document.body.appendChild(submenu);
        submenu.classList.add('context-submenu-visible');
        activeSubmenu = { element: submenu, row };

        // Position using viewport coordinates
        const rowRect = row.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();

        submenu.style.top = `${rowRect.top}px`;
        submenu.style.left = `${menuRect.right - 4}px`;

        // Clamp: if off-screen right, fly out to the left
        requestAnimationFrame(() => {
          const subRect = submenu.getBoundingClientRect();
          if (subRect.right > window.innerWidth) {
            submenu.style.left = `${menuRect.left - subRect.width + 4}px`;
          }
          if (subRect.bottom > window.innerHeight) {
            submenu.style.top = `${rowRect.top - (subRect.bottom - window.innerHeight) - 4}px`;
          }
        });
      });

      row.addEventListener('mouseleave', (e) => {
        // If mouse moved to the submenu, keep it open
        if (e.relatedTarget && submenu.contains(e.relatedTarget)) return;
        _hideActiveSubmenu();
      });

      submenu.addEventListener('mouseleave', (e) => {
        // If mouse moved back to the row, keep it open
        if (e.relatedTarget && row.contains(e.relatedTarget)) return;
        _hideActiveSubmenu();
      });

      menu.appendChild(row);
      continue;
    }

    // ── Regular item ────────────────────────────
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
      if (activeMenu && !activeMenu.contains(e.target) &&
          !(activeSubmenu && activeSubmenu.element.contains(e.target))) {
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
  _hideActiveSubmenu();
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
