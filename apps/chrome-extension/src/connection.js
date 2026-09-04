export const defaultServerUrl = 'http://127.0.0.1:4142';
export const serverUrlStorageKey = 'barbarian.serverUrl';

export function normalizeServerUrl(value) {
  const source = String(value || '').trim();
  const parsed = new URL(source || defaultServerUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http:// or https:// URL');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in the server URL');
  if (parsed.hostname === '0.0.0.0') throw new Error('Use the Barbarian host name or VPN address, not 0.0.0.0');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Enter only the server origin, without a path');
  return parsed.origin;
}

export async function loadServerUrl(storage = chrome.storage.local) {
  const stored = await storage.get(serverUrlStorageKey);
  try { return normalizeServerUrl(stored?.[serverUrlStorageKey]); }
  catch { return defaultServerUrl; }
}

export async function saveServerUrl(value, storage = chrome.storage.local) {
  const normalized = normalizeServerUrl(value);
  await storage.set({ [serverUrlStorageKey]: normalized });
  return normalized;
}

export function originPermission(serverUrl) {
  return `${normalizeServerUrl(serverUrl)}/*`;
}
