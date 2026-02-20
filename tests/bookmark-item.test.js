// Tests for the bookmark item renderer

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createBookmarkItem } from '../sidepanel/components/bookmark-item.js';

describe('createBookmarkItem', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  const bookmarkNode = {
    id: '42',
    title: 'Google',
    url: 'https://google.com',
  };

  const folderNode = {
    id: '50',
    title: 'Dev Resources',
    children: [],
  };

  // ── Basic Rendering ─────────────────────────────

  it('renders a bookmark link with title and favicon', () => {
    const item = createBookmarkItem(bookmarkNode, { depth: 0 });
    document.body.appendChild(item);

    expect(item.classList.contains('bookmark-link')).toBe(true);
    expect(item.classList.contains('bookmark-folder')).toBe(false);
    expect(item.dataset.id).toBe('42');
    expect(item.dataset.type).toBe('bookmark');

    const title = item.querySelector('.item-title');
    expect(title.textContent).toBe('Google');
  });

  it('renders a folder with chevron and folder icon', () => {
    const item = createBookmarkItem(folderNode, { depth: 0 });
    document.body.appendChild(item);

    expect(item.classList.contains('bookmark-folder')).toBe(true);
    expect(item.dataset.type).toBe('folder');

    const chevron = item.querySelector('.chevron');
    expect(chevron).toBeTruthy();

    const folderIcon = item.querySelector('.folder-icon');
    expect(folderIcon).toBeTruthy();
  });

  it('applies depth-based padding', () => {
    const item0 = createBookmarkItem(bookmarkNode, { depth: 0 });
    const item2 = createBookmarkItem(bookmarkNode, { depth: 2 });

    expect(item0.style.paddingLeft).toBe('12px'); // 12 + 0*16
    expect(item2.style.paddingLeft).toBe('44px'); // 12 + 2*16
  });

  it('shows expanded state for folders', () => {
    const item = createBookmarkItem(folderNode, { depth: 0, isExpanded: true });

    expect(item.classList.contains('expanded')).toBe(true);
    const chevron = item.querySelector('.chevron');
    expect(chevron.classList.contains('chevron-expanded')).toBe(true);
  });

  it('shows pinned badge when isPinned is true', () => {
    const item = createBookmarkItem(bookmarkNode, { depth: 0, isPinned: true });

    expect(item.classList.contains('pinned')).toBe(true);
    const pinBadge = item.querySelector('.pin-badge');
    expect(pinBadge).toBeTruthy();
  });

  // ── Draggable ───────────────────────────────────

  it('makes items draggable', () => {
    const item = createBookmarkItem(bookmarkNode, { depth: 0 });
    expect(item.draggable).toBe(true);
  });

  // ── Click Handlers ──────────────────────────────

  it('calls onClick for bookmark clicks', () => {
    const onClick = vi.fn();
    const item = createBookmarkItem(bookmarkNode, { depth: 0, onClick });
    item.click();
    expect(onClick).toHaveBeenCalledWith(bookmarkNode);
  });

  it('calls onToggle for folder clicks', () => {
    const onToggle = vi.fn();
    const item = createBookmarkItem(folderNode, { depth: 0, onToggle });
    item.click();
    expect(onToggle).toHaveBeenCalledWith('50');
  });

  it('calls onToggle when chevron is clicked', () => {
    const onToggle = vi.fn();
    const item = createBookmarkItem(folderNode, { depth: 0, onToggle });
    const chevron = item.querySelector('.chevron');
    chevron.click();
    // The chevron click AND the item click both call onToggle
    // The chevron's stopPropagation prevents the second call
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledWith('50');
  });

  // ── Context Menu ────────────────────────────────

  it('calls onContextMenu on right-click', () => {
    const onContextMenu = vi.fn();
    const item = createBookmarkItem(bookmarkNode, { depth: 0, onContextMenu });
    document.body.appendChild(item);

    const evt = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 200,
    });
    item.dispatchEvent(evt);

    expect(onContextMenu).toHaveBeenCalledTimes(1);
    expect(onContextMenu).toHaveBeenCalledWith(bookmarkNode, { x: 100, y: 200 });
  });

  it('does not add contextmenu listener when onContextMenu is not provided', () => {
    const item = createBookmarkItem(bookmarkNode, { depth: 0 });
    document.body.appendChild(item);

    // Should not throw — no listener attached
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    item.dispatchEvent(evt);
  });

  // ── Subfolder Button ────────────────────────────

  it('shows subfolder "+" button on folders when onAddSubfolder is provided', () => {
    const onAddSubfolder = vi.fn();
    const item = createBookmarkItem(folderNode, { depth: 0, onAddSubfolder });

    const addBtn = item.querySelector('.subfolder-add');
    expect(addBtn).toBeTruthy();
  });

  it('does not show subfolder button on bookmarks', () => {
    const onAddSubfolder = vi.fn();
    const item = createBookmarkItem(bookmarkNode, { depth: 0, onAddSubfolder });

    const addBtn = item.querySelector('.subfolder-add');
    expect(addBtn).toBeFalsy();
  });

  it('calls onAddSubfolder when "+" button is clicked', () => {
    const onAddSubfolder = vi.fn();
    const item = createBookmarkItem(folderNode, { depth: 0, onAddSubfolder });

    const addBtn = item.querySelector('.subfolder-add');
    addBtn.click();
    expect(onAddSubfolder).toHaveBeenCalledWith('50');
  });

  // ── Drop Target (Folders) ──────────────────────

  it('sets up drop target on folders when onDrop is provided', () => {
    const onDrop = vi.fn();
    const item = createBookmarkItem(folderNode, { depth: 0, onDrop });
    document.body.appendChild(item);

    // Simulate dragover
    const dragoverEvt = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragoverEvt, 'dataTransfer', {
      value: { dropEffect: '', effectAllowed: '' },
    });
    item.dispatchEvent(dragoverEvt);

    expect(item.classList.contains('drag-over')).toBe(true);
  });

  it('does not set up drop target on bookmarks', () => {
    const onDrop = vi.fn();
    const item = createBookmarkItem(bookmarkNode, { depth: 0, onDrop });
    document.body.appendChild(item);

    const dragoverEvt = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragoverEvt, 'dataTransfer', {
      value: { dropEffect: '', effectAllowed: '' },
    });
    item.dispatchEvent(dragoverEvt);

    expect(item.classList.contains('drag-over')).toBe(false);
  });

  // ── Edge Cases ──────────────────────────────────

  it('handles bookmark with no title (uses hostname)', () => {
    const node = { id: '99', url: 'https://example.com/page' };
    const item = createBookmarkItem(node, { depth: 0 });
    const title = item.querySelector('.item-title');
    expect(title.textContent).toBe('example.com');
  });

  it('handles folder with no title', () => {
    const node = { id: '99', children: [] };
    const item = createBookmarkItem(node, { depth: 0 });
    const title = item.querySelector('.item-title');
    expect(title.textContent).toBe('Untitled Folder');
  });
});
