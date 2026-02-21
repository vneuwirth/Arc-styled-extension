// Global test setup — mocks all Chrome extension APIs

import { vi } from 'vitest';

// ── Chrome Storage Mock ──────────────────────────────

const storageData = { sync: {}, local: {} };

function createStorageArea(area) {
  return {
    get: vi.fn(async (keys) => {
      if (!keys) return { ...storageData[area] };
      if (typeof keys === 'string') keys = [keys];
      const result = {};
      for (const k of keys) {
        if (k in storageData[area]) result[k] = storageData[area][k];
      }
      return result;
    }),
    set: vi.fn(async (data) => {
      Object.assign(storageData[area], data);
    }),
    remove: vi.fn(async (keys) => {
      if (typeof keys === 'string') keys = [keys];
      for (const k of keys) delete storageData[area][k];
    }),
    clear: vi.fn(async () => {
      storageData[area] = {};
    }),
  };
}

// ── Chrome Bookmarks Mock ────────────────────────────

let bookmarkIdCounter = 100;
let bookmarkTree = [
  {
    id: '0',
    title: '',
    children: [
      { id: '1', title: 'Bookmarks Bar', children: [] },
      { id: '2', title: 'Other Bookmarks', children: [] },
    ],
  },
];

function findNode(id, nodes = bookmarkTree) {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNode(id, node.children);
      if (found) return found;
    }
  }
  return null;
}

function findParent(id, nodes = bookmarkTree, parent = null) {
  for (const node of nodes) {
    if (node.id === id) return parent;
    if (node.children) {
      const found = findParent(id, node.children, node);
      if (found) return found;
    }
  }
  return null;
}

function removeNode(id) {
  const parent = findParent(id);
  if (parent && parent.children) {
    parent.children = parent.children.filter((c) => c.id !== id);
  }
}

function cloneNode(node) {
  const clone = { ...node };
  if (node.children) {
    clone.children = node.children.map(cloneNode);
  }
  return clone;
}

const chromeBookmarks = {
  getTree: vi.fn(async () => bookmarkTree.map(cloneNode)),

  getSubTree: vi.fn(async (id) => {
    const node = findNode(id);
    return node ? [cloneNode(node)] : [];
  }),

  getChildren: vi.fn(async (id) => {
    const node = findNode(id);
    return node && node.children ? node.children.map(cloneNode) : [];
  }),

  get: vi.fn(async (idOrIds) => {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    const results = [];
    for (const id of ids) {
      const node = findNode(id);
      if (node) results.push(cloneNode(node));
    }
    return results;
  }),

  create: vi.fn(async ({ parentId, title, url, index }) => {
    const parent = findNode(parentId);
    if (!parent) throw new Error(`Parent ${parentId} not found`);
    if (!parent.children) parent.children = [];
    const newNode = {
      id: String(++bookmarkIdCounter),
      parentId,
      title: title || '',
      index: index ?? parent.children.length,
    };
    if (url) {
      newNode.url = url;
    } else {
      newNode.children = [];
    }
    if (index !== undefined) {
      parent.children.splice(index, 0, newNode);
    } else {
      parent.children.push(newNode);
    }
    return cloneNode(newNode);
  }),

  update: vi.fn(async (id, changes) => {
    const node = findNode(id);
    if (!node) throw new Error(`Bookmark ${id} not found`);
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined) node.url = changes.url;
    return cloneNode(node);
  }),

  move: vi.fn(async (id, destination) => {
    const node = findNode(id);
    if (!node) throw new Error(`Bookmark ${id} not found`);
    removeNode(id);
    const newParent = findNode(destination.parentId || node.parentId);
    if (!newParent || !newParent.children) throw new Error('Invalid destination');
    node.parentId = newParent.id;
    if (destination.index !== undefined) {
      newParent.children.splice(destination.index, 0, node);
    } else {
      newParent.children.push(node);
    }
    // Update index on all children so get() returns correct indices
    newParent.children.forEach((child, i) => { child.index = i; });
    return cloneNode(node);
  }),

  remove: vi.fn(async (id) => {
    removeNode(id);
  }),

  removeTree: vi.fn(async (id) => {
    removeNode(id);
  }),

  search: vi.fn(async (query) => {
    const results = [];
    const walk = (node) => {
      if (node.title && node.title.includes(query)) {
        results.push(cloneNode(node));
      }
      if (node.children) node.children.forEach(walk);
    };
    bookmarkTree.forEach(walk);
    return results;
  }),
};

// ── Chrome Tabs Mock ─────────────────────────────────

const chromeTabs = {
  query: vi.fn((queryInfo, callback) => {
    const tabs = [{ id: 1, url: 'https://example.com', title: 'Example' }];
    if (callback) callback(tabs);
    return Promise.resolve(tabs);
  }),
  update: vi.fn(async () => ({})),
  create: vi.fn(async () => ({ id: 2 })),
  goBack: vi.fn(async () => {}),
  goForward: vi.fn(async () => {}),
  reload: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  duplicate: vi.fn(async () => ({ id: 3 })),
};

// ── Navigator Clipboard Mock ─────────────────────────
if (!globalThis.navigator) globalThis.navigator = {};
globalThis.navigator.clipboard = {
  writeText: vi.fn(async () => {}),
  readText: vi.fn(async () => ''),
};

// ── Chrome Runtime Mock ──────────────────────────────

const runtimeListeners = [];
const chromeRuntime = {
  getURL: vi.fn((path) => `chrome-extension://fake-id${path}`),
  onMessage: {
    addListener: vi.fn((fn) => runtimeListeners.push(fn)),
    removeListener: vi.fn((fn) => {
      const idx = runtimeListeners.indexOf(fn);
      if (idx >= 0) runtimeListeners.splice(idx, 1);
    }),
  },
  sendMessage: vi.fn(async (msg) => {
    for (const fn of runtimeListeners) fn(msg, {}, () => {});
  }),
};

// ── Chrome Storage onChange Mock ──────────────────────

const storageChangeListeners = [];
const chromeStorageOnChanged = {
  addListener: vi.fn((fn) => storageChangeListeners.push(fn)),
  removeListener: vi.fn((fn) => {
    const idx = storageChangeListeners.indexOf(fn);
    if (idx >= 0) storageChangeListeners.splice(idx, 1);
  }),
};

// ── Assemble the global chrome object ────────────────

globalThis.chrome = {
  storage: {
    sync: createStorageArea('sync'),
    local: createStorageArea('local'),
    onChanged: chromeStorageOnChanged,
  },
  bookmarks: chromeBookmarks,
  tabs: chromeTabs,
  runtime: chromeRuntime,
  sidePanel: {
    setPanelBehavior: vi.fn(async () => {}),
  },
};

// ── Test Helpers ─────────────────────────────────────

/**
 * Reset all mock state between tests.
 */
export function resetMocks() {
  storageData.sync = {};
  storageData.local = {};
  bookmarkIdCounter = 100;
  bookmarkTree = [
    {
      id: '0',
      title: '',
      children: [
        { id: '1', title: 'Bookmarks Bar', children: [] },
        { id: '2', title: 'Other Bookmarks', children: [] },
      ],
    },
  ];
  runtimeListeners.length = 0;
  storageChangeListeners.length = 0;
  vi.clearAllMocks();
}

/**
 * Seed the bookmark tree with test data.
 * Returns the IDs of created nodes.
 */
export async function seedBookmarks() {
  // Create "Arc Spaces" root under "Other Bookmarks"
  const arcRoot = await chrome.bookmarks.create({ parentId: '2', title: 'Arc Spaces' });
  // Create a workspace folder
  const wsFolder = await chrome.bookmarks.create({ parentId: arcRoot.id, title: 'Personal' });
  // Create some bookmarks
  const bm1 = await chrome.bookmarks.create({ parentId: wsFolder.id, title: 'Google', url: 'https://google.com' });
  const bm2 = await chrome.bookmarks.create({ parentId: wsFolder.id, title: 'GitHub', url: 'https://github.com' });
  // Create a subfolder
  const subFolder = await chrome.bookmarks.create({ parentId: wsFolder.id, title: 'Dev Resources' });
  const bm3 = await chrome.bookmarks.create({ parentId: subFolder.id, title: 'MDN', url: 'https://developer.mozilla.org' });

  return { arcRoot, wsFolder, bm1, bm2, subFolder, bm3 };
}

/**
 * Get the current bookmark tree (for assertions).
 */
export function getBookmarkTree() {
  return bookmarkTree;
}
