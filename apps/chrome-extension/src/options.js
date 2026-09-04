import { loadServerUrl, normalizeServerUrl, originPermission, saveServerUrl } from './connection.js';

const form = document.querySelector('form');
const input = document.querySelector('#server-url');
const output = document.querySelector('output');
const testButton = document.querySelector('#test');

function report(message, error = false) {
  output.textContent = message;
  output.className = error ? 'error' : 'success';
}

async function requestAccess(serverUrl) {
  const origin = originPermission(serverUrl);
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

async function testConnection() {
  const serverUrl = normalizeServerUrl(input.value);
  if (!await requestAccess(serverUrl)) throw new Error('Chrome did not grant access to that server');
  const response = await fetch(`${serverUrl}/api/health`);
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.service !== 'barbarian') throw new Error('That address did not respond as a Barbarian server');
  report(`Connected to Barbarian at ${serverUrl}`);
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void (async () => {
    let savedUrl = '';
    try {
      const serverUrl = normalizeServerUrl(input.value);
      if (!await requestAccess(serverUrl)) throw new Error('Chrome did not grant access to that server');
      await saveServerUrl(serverUrl);
      savedUrl = serverUrl;
      await testConnection();
      report(`Saved ${serverUrl}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report(savedUrl ? `Saved ${savedUrl}, but the connection test failed: ${message}` : message, true);
    }
  })();
});

testButton.addEventListener('click', () => {
  void testConnection().catch((error) => report(error instanceof Error ? error.message : String(error), true));
});

input.value = await loadServerUrl();
