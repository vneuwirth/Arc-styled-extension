// Workspace switcher — vertical space bar (Arc-style colored circle icons)

import { el, clearChildren } from '../utils/dom.js';
import { workspaceService } from '../services/workspace-service.js';
import { themeService } from '../services/theme-service.js';
import { storageService } from '../services/storage-service.js';
import { bus, Events } from '../utils/event-bus.js';

export class WorkspaceSwitcher {
  /**
   * @param {HTMLElement} container - The #space-bar element
   */
  constructor(container) {
    this.container = container;
    this._unsubscribers = [];
    this._popover = null;        // active create/rename popover
    this._outsideClickHandler = null;
  }

  async init() {
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this.render()),
      bus.on(Events.WORKSPACE_CREATED, () => this.render()),
      bus.on(Events.WORKSPACE_DELETED, () => this.render()),
      bus.on(Events.WORKSPACE_RENAMED, () => this.render()),
    );

    // Restore compact mode state
    const compact = await storageService.getSidebarCompact();
    if (compact) {
      document.getElementById('app-body')?.classList.add('compact');
    }

    this.render();
  }

  render() {
    clearChildren(this.container);
    this._closePopover();

    const workspaces = workspaceService.getAll();
    const active = workspaceService.getActive();

    // Render each workspace as a colored circle icon
    for (const ws of workspaces) {
      const isActive = active && ws.id === active.id;
      const initial = (ws.name || '?').charAt(0).toUpperCase();

      const btn = el('button', {
        className: ['space-icon', isActive ? 'active' : ''],
        dataset: { tooltip: ws.name, workspaceId: ws.id },
        events: {
          click: () => this._switchWorkspace(ws.id),
          dblclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._showRenamePopover(ws, btn);
          }
        }
      });

      const inner = el('span', {
        className: 'space-icon-inner',
        text: initial,
        style: { backgroundColor: ws.color }
      });

      btn.appendChild(inner);
      this.container.appendChild(btn);
    }

    // "+" button to add a workspace
    const addBtn = el('button', {
      className: 'space-add-btn',
      attrs: { title: 'New workspace' },
      events: { click: () => this._showCreatePopover() }
    });
    addBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 3V13M3 8H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>`;
    this.container.appendChild(addBtn);

    // ── Spacer to push collapse toggle to the bottom ──
    const spacer = el('div', { style: { flex: '1' } });
    this.container.appendChild(spacer);

    // ── Collapse / Expand toggle ──
    const collapseBtn = el('button', {
      className: 'collapse-toggle',
      attrs: { title: 'Toggle sidebar', type: 'button' },
      events: {
        click: () => this._toggleCompact()
      }
    });
    collapseBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10 3L5 8L10 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    this.container.appendChild(collapseBtn);
  }

  async _switchWorkspace(id) {
    // If in compact mode, expand sidebar when switching workspace
    const appBody = document.getElementById('app-body');
    if (appBody && appBody.classList.contains('compact')) {
      appBody.classList.remove('compact');
      storageService.setSidebarCompact(false);
    }

    await workspaceService.switchTo(id);
    const ws = workspaceService.getActive();
    if (ws) themeService.apply(ws.colorScheme);
  }

  async _toggleCompact() {
    const appBody = document.getElementById('app-body');
    if (!appBody) return;
    const isCompact = appBody.classList.toggle('compact');
    await storageService.setSidebarCompact(isCompact);
  }

  // ── Create Popover ─────────────────────────────────
  _showCreatePopover() {
    this._closePopover();

    const popover = el('div', { className: 'space-create-popover' });

    // Color picker
    const colorPicker = el('div', { className: 'color-picker' });
    const colors = workspaceService.colors;
    let selectedColor = 'blue';

    for (const c of colors) {
      const swatch = el('button', {
        className: ['color-swatch', c.name === selectedColor ? 'selected' : ''],
        style: { backgroundColor: c.color },
        attrs: { title: c.name, type: 'button' },
        dataset: { color: c.name },
        events: {
          click: () => {
            colorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
            swatch.classList.add('selected');
            selectedColor = c.name;
          }
        }
      });
      colorPicker.appendChild(swatch);
    }

    // Name input
    const input = el('input', {
      className: 'workspace-create-input',
      attrs: {
        type: 'text',
        placeholder: 'Workspace name…',
        maxlength: '30'
      }
    });

    // Action buttons
    const actions = el('div', { className: 'workspace-create-actions' });

    const createBtn = el('button', {
      className: 'btn btn-primary btn-sm',
      text: 'Create',
      attrs: { type: 'button' },
      events: {
        click: async () => {
          const name = input.value.trim();
          if (!name) return;
          const newWs = await workspaceService.create(name, selectedColor);
          // Auto-switch to the newly created workspace
          await workspaceService.switchTo(newWs.id);
          themeService.apply(newWs.colorScheme);
          this._closePopover();
        }
      }
    });

    const cancelBtn = el('button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Cancel',
      attrs: { type: 'button' },
      events: { click: () => this._closePopover() }
    });

    actions.appendChild(createBtn);
    actions.appendChild(cancelBtn);

    popover.appendChild(colorPicker);
    popover.appendChild(input);
    popover.appendChild(actions);

    document.body.appendChild(popover);
    this._popover = popover;

    requestAnimationFrame(() => input.focus());

    // Keyboard shortcuts
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createBtn.click();
      if (e.key === 'Escape') this._closePopover();
    });

    // Close on outside click (deferred to avoid immediate close)
    requestAnimationFrame(() => {
      this._outsideClickHandler = (e) => {
        if (this._popover && !this._popover.contains(e.target) && !this.container.contains(e.target)) {
          this._closePopover();
        }
      };
      document.addEventListener('click', this._outsideClickHandler, true);
    });
  }

  // ── Rename Popover ─────────────────────────────────
  _showRenamePopover(ws, anchorBtn) {
    this._closePopover();

    const popover = el('div', { className: 'space-create-popover' });

    // Position the popover next to the anchor button
    const rect = anchorBtn.getBoundingClientRect();
    popover.style.top = `${rect.top}px`;
    popover.style.transform = 'none';

    const input = el('input', {
      className: 'workspace-rename-input',
      attrs: {
        type: 'text',
        value: ws.name,
        maxlength: '30'
      }
    });

    const actions = el('div', { className: 'workspace-create-actions' });

    const saveBtn = el('button', {
      className: 'btn btn-primary btn-sm',
      text: 'Save',
      attrs: { type: 'button' },
      events: {
        click: async () => {
          const newName = input.value.trim();
          if (newName && newName !== ws.name) {
            await workspaceService.rename(ws.id, newName);
          }
          this._closePopover();
        }
      }
    });

    const deleteBtn = el('button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Delete',
      style: { color: '#EF4444' },
      attrs: { type: 'button' },
      events: {
        click: async () => {
          if (workspaceService.getAll().length <= 1) return;
          await workspaceService.delete(ws.id);
          this._closePopover();
        }
      }
    });

    const cancelBtn = el('button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Cancel',
      attrs: { type: 'button' },
      events: { click: () => this._closePopover() }
    });

    actions.appendChild(saveBtn);
    actions.appendChild(deleteBtn);
    actions.appendChild(cancelBtn);

    popover.appendChild(input);
    popover.appendChild(actions);

    document.body.appendChild(popover);
    this._popover = popover;

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') this._closePopover();
    });

    requestAnimationFrame(() => {
      this._outsideClickHandler = (e) => {
        if (this._popover && !this._popover.contains(e.target) && !this.container.contains(e.target)) {
          this._closePopover();
        }
      };
      document.addEventListener('click', this._outsideClickHandler, true);
    });
  }

  // ── Popover helpers ────────────────────────────────
  _closePopover() {
    if (this._popover) {
      this._popover.remove();
      this._popover = null;
    }
    if (this._outsideClickHandler) {
      document.removeEventListener('click', this._outsideClickHandler, true);
      this._outsideClickHandler = null;
    }
  }

  destroy() {
    this._closePopover();
    for (const unsub of this._unsubscribers) {
      unsub();
    }
  }
}
