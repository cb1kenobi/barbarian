import { githubPullRequestKey, isAllowedApiMessage } from './api-policy.js';

const endpoint = 'http://127.0.0.1:4142';
const panelPath = 'src/sidepanel.html';

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

async function configureTab(tabId, url) {
  const enabled = Boolean(githubPullRequestKey(url || ''));
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
  if (change.url || change.status === 'complete') void configureTab(tabId, change.url || tab.url).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'barbarian-api') void proxyApi(message, sender).then(sendResponse);
  else if (message?.type === 'barbarian-active-selection') void activeSelection(sender).then(sendResponse);
  else return false;
  return true;
});
