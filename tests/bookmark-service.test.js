// Tests for the bookmark service

import { describe, it, expect, beforeEach } from 'vitest';
import { resetMocks, seedBookmarks } from './setup.js';
import { bookmarkService } from '../sidepanel/services/bookmark-service.js';

describe('BookmarkService', () => {
  beforeEach(() => {
    resetMocks();
  });

  // ── getTree / getSubTree / getChildren ─────────

  it('getTree returns the full bookmark tree', async () => {
    const tree = await bookmarkService.getTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe('0');
    expect(tree[0].children).toHaveLength(2);
  });

  it('getSubTree returns subtree for a valid folder', async () => {
    const { wsFolder } = await seedBookmarks();
    const subtree = await bookmarkService.getSubTree(wsFolder.id);
    expect(subtree).toHaveLength(1);
    expect(subtree[0].title).toBe('Personal');
    expect(subtree[0].children.length).toBeGreaterThanOrEqual(2);
  });

  it('getSubTree returns empty array for invalid id', async () => {
    const subtree = await bookmarkService.getSubTree('nonexistent');
    expect(subtree).toEqual([]);
  });

  it('getChildren returns direct children', async () => {
    const { wsFolder } = await seedBookmarks();
    const children = await bookmarkService.getChildren(wsFolder.id);
    expect(children.length).toBe(3); // bm1, bm2, subFolder
  });

  // ── get / getMultiple ──────────────────────────

  it('get returns a single bookmark', async () => {
    const { bm1 } = await seedBookmarks();
    const result = await bookmarkService.get(bm1.id);
    expect(result.title).toBe('Google');
    expect(result.url).toBe('https://google.com');
  });

  it('get returns null for invalid id', async () => {
    const result = await bookmarkService.get('nonexistent');
    expect(result).toBeNull();
  });

  it('getMultiple returns valid bookmarks, skips stale IDs', async () => {
    const { bm1, bm2 } = await seedBookmarks();
    const results = await bookmarkService.getMultiple([bm1.id, 'stale_id', bm2.id]);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Google');
    expect(results[1].title).toBe('GitHub');
  });

  // ── create ─────────────────────────────────────

  it('creates a bookmark with url', async () => {
    const { wsFolder } = await seedBookmarks();
    const newBm = await bookmarkService.create({
      parentId: wsFolder.id,
      title: 'New Site',
      url: 'https://newsite.com',
    });
    expect(newBm.title).toBe('New Site');
    expect(newBm.url).toBe('https://newsite.com');

    // Verify it's in the tree
    const children = await bookmarkService.getChildren(wsFolder.id);
    expect(children.some((c) => c.title === 'New Site')).toBe(true);
  });

  it('creates a folder (no url)', async () => {
    const { wsFolder } = await seedBookmarks();
    const newFolder = await bookmarkService.create({
      parentId: wsFolder.id,
      title: 'New Folder',
    });
    expect(newFolder.title).toBe('New Folder');
    expect(newFolder.url).toBeUndefined();
    expect(newFolder.children).toEqual([]);
    expect(bookmarkService.isFolder(newFolder)).toBe(true);
  });

  // ── update ─────────────────────────────────────

  it('updates a bookmark title', async () => {
    const { bm1 } = await seedBookmarks();
    const updated = await bookmarkService.update(bm1.id, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');

    // Verify persistence
    const fetched = await bookmarkService.get(bm1.id);
    expect(fetched.title).toBe('Renamed');
  });

  it('updates a bookmark url', async () => {
    const { bm1 } = await seedBookmarks();
    await bookmarkService.update(bm1.id, { url: 'https://new.google.com' });
    const fetched = await bookmarkService.get(bm1.id);
    expect(fetched.url).toBe('https://new.google.com');
  });

  // ── move ───────────────────────────────────────

  it('moves a bookmark to a different folder', async () => {
    const { bm1, subFolder, wsFolder } = await seedBookmarks();

    await bookmarkService.move(bm1.id, { parentId: subFolder.id });

    // Should no longer be in the workspace root
    const wsChildren = await bookmarkService.getChildren(wsFolder.id);
    expect(wsChildren.some((c) => c.id === bm1.id)).toBe(false);

    // Should be in the subfolder
    const subChildren = await bookmarkService.getChildren(subFolder.id);
    expect(subChildren.some((c) => c.id === bm1.id)).toBe(true);
  });

  // ── remove / removeTree ────────────────────────

  it('removes a single bookmark', async () => {
    const { bm1, wsFolder } = await seedBookmarks();
    await bookmarkService.remove(bm1.id);

    const children = await bookmarkService.getChildren(wsFolder.id);
    expect(children.some((c) => c.id === bm1.id)).toBe(false);
  });

  it('removeTree removes a folder and all its contents', async () => {
    const { subFolder, bm3, wsFolder } = await seedBookmarks();
    await bookmarkService.removeTree(subFolder.id);

    const children = await bookmarkService.getChildren(wsFolder.id);
    expect(children.some((c) => c.id === subFolder.id)).toBe(false);

    // bm3 (inside subFolder) should also be gone
    const fetched = await bookmarkService.get(bm3.id);
    expect(fetched).toBeNull();
  });

  // ── search ─────────────────────────────────────

  it('searches bookmarks by title', async () => {
    await seedBookmarks();
    const results = await bookmarkService.search('Google');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].title).toBe('Google');
  });

  // ── isFolder ───────────────────────────────────

  it('correctly identifies folders vs bookmarks', () => {
    expect(bookmarkService.isFolder({ id: '1', title: 'F', children: [] })).toBe(true);
    expect(bookmarkService.isFolder({ id: '2', title: 'B', url: 'http://x.com' })).toBe(false);
  });

  // ── onMessage ──────────────────────────────────

  it('subscribes to runtime messages for bookmark events', () => {
    const callback = () => {};
    const unsub = bookmarkService.onMessage(callback);

    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();

    unsub();
    expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
  });
});
