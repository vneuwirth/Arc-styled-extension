import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetMocks, seedBookmarks } from './setup.js';
import { workspaceService } from '../sidepanel/services/workspace-service.js';
import { ShortcutBar } from '../sidepanel/components/shortcut-bar.js';

describe('ShortcutBar', () => {
  let container;
  let bar;

  beforeEach(async () => {
    resetMocks();
    document.body.innerHTML = '<div id="shortcut-bar"></div>';
    container = document.getElementById('shortcut-bar');

    // Initialize workspace service with test data
    const { arcRoot, wsFolder } = await seedBookmarks();
    await chrome.storage.sync.set({
      arcSpacesRootId: arcRoot.id,
      workspaces: {
        activeWorkspaceId: 'ws_default',
        order: ['ws_default'],
        items: {
          ws_default: {
            id: 'ws_default',
            name: 'Personal',
            color: '#7C5CFC',
            colorScheme: 'purple',
            pinnedBookmarkIds: [],
            shortcuts: [
              { url: 'https://google.com', title: 'Google' },
              { url: 'https://github.com', title: 'GitHub' },
            ],
            rootFolderId: wsFolder.id,
            created: Date.now(),
          },
        },
      },
    });
    await workspaceService.init();

    bar = new ShortcutBar(container);
    bar.init();
  });

  // ── Rendering ─────────────────────────────────────

  it('renders shortcut icons for each URL in workspace shortcuts', () => {
    const icons = container.querySelectorAll('.shortcut-icon');
    expect(icons.length).toBe(2);
  });

  it('renders a "+" add button at the end', () => {
    const addBtn = container.querySelector('.shortcut-add-btn');
    expect(addBtn).toBeTruthy();
    expect(addBtn.getAttribute('title')).toBe('Add current tab as shortcut');
  });

  it('renders shortcuts inside a .shortcut-bar wrapper', () => {
    const wrapper = container.querySelector('.shortcut-bar');
    expect(wrapper).toBeTruthy();
    // 2 shortcut icons + 1 add button = 3 children
    expect(wrapper.children.length).toBe(3);
  });

  it('shows website title as tooltip on shortcut icons', () => {
    const icons = container.querySelectorAll('.shortcut-icon');
    expect(icons[0].getAttribute('title')).toBe('Google');
    expect(icons[1].getAttribute('title')).toBe('GitHub');
  });

  it('each shortcut icon contains a favicon img', () => {
    const icons = container.querySelectorAll('.shortcut-icon');
    for (const icon of icons) {
      expect(icon.querySelector('.favicon')).toBeTruthy();
    }
  });

  it('each shortcut icon contains a fallback letter', () => {
    const icons = container.querySelectorAll('.shortcut-icon');
    const fallback0 = icons[0].querySelector('.shortcut-icon-fallback');
    const fallback1 = icons[1].querySelector('.shortcut-icon-fallback');
    expect(fallback0.textContent).toBe('G'); // google.com → G
    expect(fallback1.textContent).toBe('G'); // github.com → G
  });

  // ── Click Actions ─────────────────────────────────

  it('clicking a shortcut icon calls chrome.tabs.update with the URL', async () => {
    const icons = container.querySelectorAll('.shortcut-icon');
    icons[0].click();
    await new Promise(r => setTimeout(r, 0));
    expect(chrome.tabs.update).toHaveBeenCalledWith(1, { url: 'https://google.com' });
  });

  it('"+" button adds current tab to shortcuts', async () => {
    const addBtn = container.querySelector('.shortcut-add-btn');
    addBtn.click();
    await new Promise(r => setTimeout(r, 0));
    const shortcuts = workspaceService.getShortcuts();
    expect(shortcuts.length).toBe(3);
    expect(shortcuts[2].url).toBe('https://example.com');
    expect(shortcuts[2].title).toBe('Example');
  });

  it('"+" button does not add duplicate URLs', async () => {
    // Mock tab to return a URL that's already a shortcut
    chrome.tabs.query.mockResolvedValueOnce([{ id: 1, url: 'https://google.com', title: 'Google' }]);
    const addBtn = container.querySelector('.shortcut-add-btn');
    addBtn.click();
    await new Promise(r => setTimeout(r, 0));
    const shortcuts = workspaceService.getShortcuts();
    expect(shortcuts.length).toBe(2); // unchanged
  });

  it('"+" button skips chrome:// URLs', async () => {
    chrome.tabs.query.mockResolvedValueOnce([{ id: 1, url: 'chrome://settings', title: 'Settings' }]);
    const addBtn = container.querySelector('.shortcut-add-btn');
    addBtn.click();
    await new Promise(r => setTimeout(r, 0));
    const shortcuts = workspaceService.getShortcuts();
    expect(shortcuts.length).toBe(2); // unchanged
  });

  // ── Context Menu ──────────────────────────────────

  it('right-click on shortcut shows context menu', () => {
    const icons = container.querySelectorAll('.shortcut-icon');
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    });
    icons[0].dispatchEvent(event);
    // Context menu should be appended to body
    const menu = document.querySelector('.context-menu');
    expect(menu).toBeTruthy();
    const items = menu.querySelectorAll('.context-menu-item');
    expect(items[0].textContent).toBe('Remove shortcut');
  });

  // ── Empty State ───────────────────────────────────

  it('shows only "+" button when no shortcuts exist', async () => {
    // Clear shortcuts
    const ws = workspaceService.getActive();
    ws.shortcuts = [];
    bar.render();

    const icons = container.querySelectorAll('.shortcut-icon');
    expect(icons.length).toBe(0);
    const addBtn = container.querySelector('.shortcut-add-btn');
    expect(addBtn).toBeTruthy();
  });

  // ── Event Handling ────────────────────────────────

  it('re-renders on WORKSPACE_CHANGED event', async () => {
    const { bus, Events } = await import('../sidepanel/utils/event-bus.js');
    const renderSpy = vi.spyOn(bar, 'render');
    bus.emit(Events.WORKSPACE_CHANGED, { id: 'ws_1', name: 'Test' });
    expect(renderSpy).toHaveBeenCalled();
  });

  it('re-renders on SHORTCUT_ADDED event', async () => {
    const { bus, Events } = await import('../sidepanel/utils/event-bus.js');
    const renderSpy = vi.spyOn(bar, 'render');
    bus.emit(Events.SHORTCUT_ADDED, { url: 'https://test.com' });
    expect(renderSpy).toHaveBeenCalled();
  });

  it('re-renders on SHORTCUT_REMOVED event', async () => {
    const { bus, Events } = await import('../sidepanel/utils/event-bus.js');
    const renderSpy = vi.spyOn(bar, 'render');
    bus.emit(Events.SHORTCUT_REMOVED, { url: 'https://test.com' });
    expect(renderSpy).toHaveBeenCalled();
  });

  // ── Cleanup ───────────────────────────────────────

  it('destroy() cleans up event subscriptions', () => {
    expect(bar._unsubscribers.length).toBe(3);
    bar.destroy();
    // Should not throw
  });

  // ── Edge cases ────────────────────────────────────

  it('handles tab with no URL gracefully on add', async () => {
    chrome.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
    const addBtn = container.querySelector('.shortcut-add-btn');
    addBtn.click();
    await new Promise(r => setTimeout(r, 0));
    const shortcuts = workspaceService.getShortcuts();
    expect(shortcuts.length).toBe(2); // unchanged
  });

  it('handles no active tab gracefully on click', async () => {
    chrome.tabs.query.mockResolvedValueOnce([]);
    const icons = container.querySelectorAll('.shortcut-icon');
    icons[0].click();
    await new Promise(r => setTimeout(r, 0));
    // Should not throw and should not call update
    expect(chrome.tabs.update).not.toHaveBeenCalled();
  });
});
