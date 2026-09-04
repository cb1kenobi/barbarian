export const defaultServerUrl = 'http://127.0.0.1:4142';

export function normalizeServerUrl(value: string): string {
  const parsed = new URL(value.trim() || defaultServerUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Use an http:// or https:// URL');
  if (parsed.username || parsed.password) throw new Error('Credentials are not allowed in the server URL');
  if (parsed.hostname === '0.0.0.0') throw new Error('Use the Barbarian host name or VPN address, not 0.0.0.0');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Enter only the server origin, without a path');
  return parsed.origin;
}
