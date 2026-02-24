// Workspace switcher — vertical space bar (Arc-style colored circle icons)
// Right-click context menu for Rename / Change Color / Set Icon / Delete
// Drag-and-drop reordering of workspace circles

import { el, clearChildren } from '../utils/dom.js';
import { workspaceService } from '../services/workspace-service.js';
import { themeService } from '../services/theme-service.js';
import { storageService } from '../services/storage-service.js';
import { showContextMenu } from './context-menu.js';
import { bus, Events } from '../utils/event-bus.js';

export class WorkspaceSwitcher {
  /**
   * @param {HTMLElement} container - The #space-bar element
   */
  constructor(container) {
    this.container = container;
    this._unsubscribers = [];
    this._popover = null;        // active create/rename/emoji popover
    this._outsideClickHandler = null;
  }

  async init() {
    this._unsubscribers.push(
      bus.on(Events.WORKSPACE_CHANGED, () => this.render()),
      bus.on(Events.WORKSPACE_CREATED, () => this.render()),
      bus.on(Events.WORKSPACE_DELETED, () => this.render()),
      bus.on(Events.WORKSPACE_RENAMED, () => this.render()),
      bus.on(Events.WORKSPACE_REORDERED, () => this.render()),
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
      const hasEmoji = ws.emoji && ws.emoji.length > 0;
      const displayText = hasEmoji ? ws.emoji : initial;

      const btn = el('button', {
        className: ['space-icon', isActive ? 'active' : ''],
        dataset: { tooltip: ws.name, workspaceId: ws.id },
        events: {
          click: () => this._switchWorkspace(ws.id),
          contextmenu: (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._showWorkspaceContextMenu(ws, { x: e.clientX, y: e.clientY });
          }
        }
      });

      const inner = el('span', {
        className: ['space-icon-inner', hasEmoji ? 'space-icon-emoji' : ''],
        text: displayText,
        style: { backgroundColor: hasEmoji ? 'transparent' : ws.color }
      });

      btn.appendChild(inner);

      // ── Drag-and-drop for reordering ──
      btn.draggable = true;

      btn.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-workspace-id', ws.id);
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => btn.classList.add('space-icon-dragging'));
      });

      btn.addEventListener('dragend', () => {
        btn.classList.remove('space-icon-dragging');
        this.container.querySelectorAll('.space-icon').forEach(el => {
          el.classList.remove('space-drop-before', 'space-drop-after');
        });
      });

      btn.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';

        // Clear previous indicators on all siblings
        this.container.querySelectorAll('.space-icon').forEach(el => {
          el.classList.remove('space-drop-before', 'space-drop-after');
        });

        // Determine top/bottom half for insertion indicator
        const rect = btn.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (y < rect.height / 2) {
          btn.classList.add('space-drop-before');
        } else {
          btn.classList.add('space-drop-after');
        }
      });

      btn.addEventListener('dragleave', (e) => {
        if (!btn.contains(e.relatedTarget)) {
          btn.classList.remove('space-drop-before', 'space-drop-after');
        }
      });

      btn.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const draggedId = e.dataTransfer.getData('application/x-workspace-id');
        btn.classList.remove('space-drop-before', 'space-drop-after');

        if (!draggedId || draggedId === ws.id) return;

        // Calculate new order
        const currentOrder = workspaceService.getAll().map(w => w.id);
        const fromIndex = currentOrder.indexOf(draggedId);
        if (fromIndex === -1) return;

        // Remove dragged item
        currentOrder.splice(fromIndex, 1);

        // Determine insertion point
        let toIndex = currentOrder.indexOf(ws.id);
        const rect = btn.getBoundingClientRect();
        const y = e.clientY - rect.top;
        if (y >= rect.height / 2) {
          toIndex += 1; // insert after
        }

        currentOrder.splice(toIndex, 0, draggedId);
        workspaceService.reorder(currentOrder);
      });

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

  // ── Workspace Context Menu ──────────────────────────
  _showWorkspaceContextMenu(ws, pos) {
    const items = [];

    // Rename
    items.push({
      label: 'Rename',
      action: () => {
        const anchorBtn = this.container.querySelector(`[data-workspace-id="${ws.id}"]`);
        if (anchorBtn) {
          this._showRenamePopover(ws, anchorBtn);
        }
      }
    });

    // Change Color submenu — show as color swatches in context menu
    items.push({
      label: 'Change color…',
      action: () => {
        const anchorBtn = this.container.querySelector(`[data-workspace-id="${ws.id}"]`);
        if (anchorBtn) {
          this._showColorPopover(ws, anchorBtn);
        }
      }
    });

    // Set icon (emoji)
    items.push({
      label: ws.emoji ? 'Change icon…' : 'Set icon…',
      action: () => {
        const anchorBtn = this.container.querySelector(`[data-workspace-id="${ws.id}"]`);
        if (anchorBtn) {
          this._showEmojiPopover(ws, anchorBtn);
        }
      }
    });

    items.push({ separator: true });

    // Delete (disabled if only 1 workspace)
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

    showContextMenu({ x: pos.x, y: pos.y, items });
  }

  // ── Color Picker Popover ──────────────────────────
  _showColorPopover(ws, anchorBtn) {
    this._closePopover();

    const popover = el('div', { className: 'space-create-popover' });

    // Position next to the anchor
    const rect = anchorBtn.getBoundingClientRect();
    popover.style.top = `${rect.top}px`;
    popover.style.transform = 'none';

    // Label
    const label = el('div', {
      className: 'popover-label',
      text: 'Choose a color'
    });
    popover.appendChild(label);

    // Color picker
    const colorPicker = el('div', { className: 'color-picker' });
    const colors = workspaceService.colors;

    for (const c of colors) {
      const swatch = el('button', {
        className: ['color-swatch', c.name === ws.colorScheme ? 'selected' : ''],
        style: { backgroundColor: c.color },
        attrs: { title: c.name, type: 'button' },
        events: {
          click: async () => {
            await workspaceService.changeColor(ws.id, c.name);
            this._closePopover();
            this.render();
          }
        }
      });
      colorPicker.appendChild(swatch);
    }

    popover.appendChild(colorPicker);

    document.body.appendChild(popover);
    this._popover = popover;

    // Close on outside click
    requestAnimationFrame(() => {
      this._outsideClickHandler = (e) => {
        if (this._popover && !this._popover.contains(e.target) && !this.container.contains(e.target)) {
          this._closePopover();
        }
      };
      document.addEventListener('click', this._outsideClickHandler, true);
    });
  }

  // ── Emoji Popover ──────────────────────────────────
  _showEmojiPopover(ws, anchorBtn) {
    this._closePopover();

    const popover = el('div', { className: 'space-create-popover' });

    // Position next to the anchor
    const rect = anchorBtn.getBoundingClientRect();
    popover.style.top = `${rect.top}px`;
    popover.style.transform = 'none';

    // Label
    const label = el('div', {
      className: 'popover-label',
      text: 'Workspace icon'
    });
    popover.appendChild(label);

    // Emoji input
    const input = el('input', {
      className: 'workspace-emoji-input',
      attrs: {
        type: 'text',
        placeholder: 'Type or paste an emoji',
        maxlength: '4',
        value: ws.emoji || ''
      }
    });
    popover.appendChild(input);

    // Actions
    const actions = el('div', { className: 'workspace-create-actions' });

    const saveBtn = el('button', {
      className: 'btn btn-primary btn-sm',
      text: 'Save',
      attrs: { type: 'button' },
      events: {
        click: async () => {
          const emoji = input.value.trim();
          await workspaceService.setEmoji(ws.id, emoji);
          this._closePopover();
        }
      }
    });

    const clearBtn = el('button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Clear',
      attrs: { type: 'button' },
      events: {
        click: async () => {
          await workspaceService.setEmoji(ws.id, '');
          this._closePopover();
        }
      }
    });

    actions.appendChild(saveBtn);
    actions.appendChild(clearBtn);
    popover.appendChild(actions);

    document.body.appendChild(popover);
    this._popover = popover;

    requestAnimationFrame(() => input.focus());

    // Keyboard shortcuts
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveBtn.click();
      if (e.key === 'Escape') this._closePopover();
    });

    // Close on outside click
    requestAnimationFrame(() => {
      this._outsideClickHandler = (e) => {
        if (this._popover && !this._popover.contains(e.target) && !this.container.contains(e.target)) {
          this._closePopover();
        }
      };
      document.addEventListener('click', this._outsideClickHandler, true);
    });
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
          try {
            const newWs = await workspaceService.create(name, selectedColor);
            if (newWs) {
              await workspaceService.switchTo(newWs.id);
              themeService.apply(newWs.colorScheme);
            }
          } catch (err) {
            console.error('Arc Spaces: failed to create workspace:', err);
          }
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

    const cancelBtn = el('button', {
      className: 'btn btn-ghost btn-sm',
      text: 'Cancel',
      attrs: { type: 'button' },
      events: { click: () => this._closePopover() }
    });

    actions.appendChild(saveBtn);
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
