// Arc Spaces - Service Worker
// Thin background script: panel behavior + bookmark event relay
// All first-run setup is handled by workspace-service.js in the side panel

// Set side panel to open on action icon click
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// Relay bookmark events to the side panel
const BOOKMARK_EVENTS = [
  'onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered'
];

for (const eventName of BOOKMARK_EVENTS) {
  chrome.bookmarks[eventName].addListener((...args) => {
    chrome.runtime.sendMessage({
      type: `bookmark:${eventName}`,
      data: args
    }).catch(() => {
      // Side panel not open — ignore silently
    });
  });
}

// Relay sync storage changes to the side panel
// Side panels may not receive onChanged events when hidden/reopened,
// so the service worker (always running) relays them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') {
    const wsKeys = Object.keys(changes).filter(
      k => k === 'ws_meta' || k.startsWith('ws_') || k === 'settings'
    );
    if (wsKeys.length > 0) {
      chrome.runtime.sendMessage({
        type: 'sync:changed',
        data: { keys: wsKeys, area }
      }).catch(() => {
        // Side panel not open — ignore silently
      });
    }
  }
});
