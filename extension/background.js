const ALLOWED_ORIGIN = 'https://chatgpt.com';
function isAllowed(url) {
  try { return new URL(url).origin === ALLOWED_ORIGIN; } catch { return false; }
}
function scopeForUrl(url) {
  const parsed = new URL(url);
  const conversation = parsed.pathname.match(/\/c\/([^/]+)/);
  return conversation ? `conversation:${conversation[1]}` : `page:${parsed.pathname.replace(/\/+$/, '') || '/'}`;
}

// Serialize updates per tab, and read its current URL when each update runs.
const pending = new Map();
function updateTab(tabId) {
  const task = (pending.get(tabId) || Promise.resolve()).then(async () => {
    const tab = await chrome.tabs.get(tabId);
    const enabled = isAllowed(tab.pendingUrl || tab.url);
    const panelPath = enabled ? `sidepanel.html?scope=${encodeURIComponent(scopeForUrl(tab.pendingUrl || tab.url))}` : 'sidepanel.html';
    const previous = await chrome.sidePanel.getOptions({ tabId });
    if (previous.path !== panelPath || previous.enabled !== enabled) {
      await chrome.sidePanel.setOptions({ tabId, path: panelPath, enabled });
    }
    await chrome.action[enabled ? 'enable' : 'disable'](tabId);
    await chrome.action.setTitle({ tabId, title: enabled ? '打开页边 Markdown' : '页边 · 在 chatgpt.com 上使用' });
  }).catch(error => {
    // A tab can close between the event and the API calls.
    if (!/No tab|Invalid tab/i.test(error.message)) console.warn('更新页边状态失败', error);
  });
  pending.set(tabId, task);
  task.finally(() => { if (pending.get(tabId) === task) pending.delete(tabId); });
  return task;
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status) void updateTab(tabId);
});
chrome.tabs.onActivated.addListener(({ tabId }) => { void updateTab(tabId); });
chrome.tabs.onCreated.addListener(tab => { void updateTab(tab.id); });

async function initialize() {
  await chrome.sidePanel.setOptions({ path: 'sidepanel.html', enabled: false });
  await chrome.action.disable();
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(tab => updateTab(tab.id)));
}
initialize().catch(error => console.error('初始化页边失败', error));
