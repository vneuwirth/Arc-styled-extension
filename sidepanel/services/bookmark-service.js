// Abstraction over chrome.bookmarks API

class BookmarkService {
  /**
   * Get the full bookmark tree.
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
   */
  async getTree() {
    return chrome.bookmarks.getTree();
  }

  /**
   * Get a subtree rooted at a specific folder.
   * @param {string} folderId
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
   */
  async getSubTree(folderId) {
    try {
      return await chrome.bookmarks.getSubTree(folderId);
    } catch {
      return [];
    }
  }

  /**
   * Get children of a folder.
   * @param {string} folderId
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
   */
  async getChildren(folderId) {
    try {
      return await chrome.bookmarks.getChildren(folderId);
    } catch {
      return [];
    }
  }

  /**
   * Get a single bookmark by ID.
   * @param {string} id
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode|null>}
   */
  async get(id) {
    try {
      const results = await chrome.bookmarks.get(id);
      return results[0] || null;
    } catch {
      return null;
    }
  }

  /**
   * Get multiple bookmarks by IDs. Returns only valid ones (skips stale IDs).
   * @param {string[]} ids
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
   */
  async getMultiple(ids) {
    const results = [];
    for (const id of ids) {
      const bookmark = await this.get(id);
      if (bookmark) results.push(bookmark);
    }
    return results;
  }

  /**
   * Create a bookmark or folder.
   * @param {Object} params
   * @param {string} params.parentId - Parent folder ID
   * @param {string} params.title - Bookmark title
   * @param {string} [params.url] - URL (omit for folders)
   * @param {number} [params.index] - Position within parent
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode>}
   */
  async create({ parentId, title, url, index }) {
    return chrome.bookmarks.create({ parentId, title, url, index });
  }

  /**
   * Update a bookmark's title and/or URL.
   * @param {string} id
   * @param {Object} changes
   * @param {string} [changes.title]
   * @param {string} [changes.url]
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode>}
   */
  async update(id, changes) {
    return chrome.bookmarks.update(id, changes);
  }

  /**
   * Move a bookmark to a new parent and/or position.
   * @param {string} id
   * @param {Object} destination
   * @param {string} [destination.parentId]
   * @param {number} [destination.index]
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode>}
   */
  async move(id, destination) {
    return chrome.bookmarks.move(id, destination);
  }

  /**
   * Remove a bookmark or empty folder.
   * @param {string} id
   */
  async remove(id) {
    return chrome.bookmarks.remove(id);
  }

  /**
   * Remove a folder and all its contents.
   * @param {string} id
   */
  async removeTree(id) {
    return chrome.bookmarks.removeTree(id);
  }

  /**
   * Search bookmarks.
   * @param {string} query
   * @returns {Promise<chrome.bookmarks.BookmarkTreeNode[]>}
   */
  async search(query) {
    return chrome.bookmarks.search(query);
  }

  /**
   * Check if a node is a folder (no url property).
   * @param {chrome.bookmarks.BookmarkTreeNode} node
   * @returns {boolean}
   */
  isFolder(node) {
    return !node.url;
  }

  /**
   * Listen for bookmark events relayed from the service worker.
   * @param {Function} callback - Called with message object
   * @returns {Function} Unsubscribe function
   */
  onMessage(callback) {
    const handler = (message) => {
      if (message.type && message.type.startsWith('bookmark:')) {
        callback(message);
      }
    };
    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }
}

export const bookmarkService = new BookmarkService();
