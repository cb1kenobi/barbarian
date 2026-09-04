import { describe, expect, it } from 'vitest';
import { defaultServerUrl, loadServerUrl, normalizeServerUrl, saveServerUrl } from './connection.js';

function memoryStorage(initial = {}) {
  const values = { ...initial };
  return {
    async get(key) { return { [key]: values[key] }; },
    async set(update) { Object.assign(values, update); },
    values,
  };
}

describe('Chrome extension connection settings', () => {
  it('normalizes server origins and rejects bind-only destinations', () => {
    expect(normalizeServerUrl(' https://barbarian.example-vpn:5150/ ')).toBe('https://barbarian.example-vpn:5150');
    expect(() => normalizeServerUrl('http://0.0.0.0:4142')).toThrow('host name or VPN address');
    expect(() => normalizeServerUrl('file:///tmp/barbarian')).toThrow('http:// or https://');
    expect(() => normalizeServerUrl('http://localhost:4142/api')).toThrow('without a path');
  });

  it('persists a valid URL and falls back from invalid stored data', async () => {
    const storage = memoryStorage();
    await expect(saveServerUrl('http://127.0.0.1:5150', storage)).resolves.toBe('http://127.0.0.1:5150');
    await expect(loadServerUrl(storage)).resolves.toBe('http://127.0.0.1:5150');
    storage.values['barbarian.serverUrl'] = 'not a url';
    await expect(loadServerUrl(storage)).resolves.toBe(defaultServerUrl);
  });
});
