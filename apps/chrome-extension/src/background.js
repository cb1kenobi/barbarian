import { githubPageContext, githubPullRequestKey, isAllowedApiMessage } from './api-policy.js';

const endpoint = 'http://127.0.0.1:4142';
const panelPath = 'src/sidepanel.html';
const recentNavigationRefreshes = new Map();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function isSidePanelSender(sender) {
  return sender.url === chrome.runtime.getURL(panelPath);
}

async function requestTab(message, sender) {
  if (sender.tab) return sender.tab;
  if (!isSidePanelSender(sender)) return null;
  return activeTab();
}

async function proxyApi(message, sender) {
  const tab = await requestTab(message, sender);
  if (!tab?.url || !isAllowedApiMessage(message, tab.url)) {
    return { ok: false, status: 403, error: 'Extension request was not allowed' };
  }

  const request = { method: message.options?.method || 'GET', headers: {} };
  if (message.options?.body != null) {
    request.body = message.options.body;
    request.headers['content-type'] = 'application/json';
  }

  try {
    const response = await fetch(`${endpoint}${message.path}`, request);
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = { error: text }; }
    }
    return { ok: response.ok, status: response.status, statusText: response.statusText, body };
  } catch (error) {
    return { ok: false, status: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

async function activeSelection(sender) {
  if (!isSidePanelSender(sender)) return null;
  const tab = await activeTab();
  if (!tab?.id || !githubPullRequestKey(tab.url || '')) return null;
  try { return await chrome.tabs.sendMessage(tab.id, { type: 'barbarian-get-selection' }); }
  catch { return null; }
}

async function panelAppearance(sender) {
  if (!isSidePanelSender(sender)) return null;
  try {
    const response = await fetch(`${endpoint}/api/settings`);
    if (!response.ok) return null;
    const body = await response.json();
    return body?.config?.appearance ? { appearance: body.config.appearance } : null;
  } catch { return null; }
}

async function refreshLoadedPage(sender, pageUrl) {
  const tab = sender.tab;
  const url = pageUrl || tab?.url || '';
  const context = githubPageContext(url);
  const tabContext = githubPageContext(tab?.url || '');
  if (!tab?.url || !context || !tabContext || tabContext.kind !== context.kind || tabContext.key !== context.key) return { ok: false };
  const endpointPath = context.kind === 'issue' ? '/api/browser/issue-context' : '/api/browser/context';
  const result = await proxyApi({
    type: 'barbarian-api',
    path: `${endpointPath}?url=${encodeURIComponent(url)}&refresh=1`,
  }, sender);
  if (!result.ok) return result;
  await chrome.runtime.sendMessage({
    type: 'barbarian-context-updated', key: context.key, kind: context.kind, context: result.body,
  }).catch(() => {});
  return { ok: true };
}

async function configureTab(tabId, url) {
  const enabled = Boolean(githubPageContext(url || ''));
  await chrome.sidePanel.setOptions(enabled
    ? { tabId, path: panelPath, enabled: true }
    : { tabId, enabled: false });
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.tabs.query({}).then((tabs) => Promise.all(tabs.map((tab) => (
  tab.id == null ? undefined : configureTab(tab.id, tab.url)
)))).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.tabs.query({}).then((tabs) => Promise.all(tabs.map((tab) => (
    tab.id == null ? undefined : configureTab(tab.id, tab.url)
  )))).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!change.url && change.status !== 'complete') return;
  const url = change.url || tab.url || '';
  void configureTab(tabId, url).catch(() => {});
  if (!githubPageContext(url)) return;
  const now = Date.now();
  const recent = recentNavigationRefreshes.get(tabId);
  if (recent?.url === url && now - recent.at < 1_500) return;
  recentNavigationRefreshes.set(tabId, { url, at: now });
  void refreshLoadedPage({ tab: { ...tab, id: tabId, url } }, url).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => recentNavigationRefreshes.delete(tabId));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'barbarian-api') void proxyApi(message, sender).then(sendResponse);
  else if (message?.type === 'barbarian-active-selection') void activeSelection(sender).then(sendResponse);
  else if (message?.type === 'barbarian-appearance') void panelAppearance(sender).then(sendResponse);
  else if (message?.type === 'barbarian-issue-updated' && sender.tab) {
    const page = githubPageContext(sender.tab.url || '');
    if (page?.kind !== 'issue') { sendResponse({ ok: false }); return false; }
    const refresh = () => refreshLoadedPage(sender, sender.tab?.url).catch(() => {});
    refresh();
    setTimeout(refresh, 700);
    setTimeout(refresh, 2_000);
    sendResponse({ ok: true });
  }
  else return false;
  return true;
});
