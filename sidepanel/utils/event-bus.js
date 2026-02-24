// Simple publish/subscribe event bus for component communication

class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);

    return () => this.off(event, callback);
  }

  /**
   * Unsubscribe from an event.
   */
  off(event, callback) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  /**
   * Emit an event with data.
   * @param {string} event
   * @param {*} data
   */
  emit(event, data) {
    const listeners = this._listeners.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (err) {
          console.error(`EventBus error in "${event}" handler:`, err);
        }
      }
    }
  }
}

// Singleton instance shared across all components
export const bus = new EventBus();

// Event name constants
export const Events = {
  WORKSPACE_CHANGED: 'workspace:changed',
  WORKSPACE_CREATED: 'workspace:created',
  WORKSPACE_DELETED: 'workspace:deleted',
  WORKSPACE_RENAMED: 'workspace:renamed',
  WORKSPACE_REORDERED: 'workspace:reordered',
  BOOKMARK_CREATED: 'bookmark:created',
  BOOKMARK_REMOVED: 'bookmark:removed',
  BOOKMARK_CHANGED: 'bookmark:changed',
  BOOKMARK_MOVED: 'bookmark:moved',
  BOOKMARK_PINNED: 'bookmark:pinned',
  BOOKMARK_UNPINNED: 'bookmark:unpinned',
  SHORTCUT_ADDED: 'shortcut:added',
  SHORTCUT_REMOVED: 'shortcut:removed',
  TREE_REFRESH: 'tree:refresh',
  THEME_CHANGED: 'theme:changed',
};
