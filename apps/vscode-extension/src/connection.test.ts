import { describe, expect, it } from 'vitest';
import { defaultServerUrl, normalizeServerUrl } from './connection.js';

describe('VS Code extension connection settings', () => {
  it('normalizes a configured server URL', () => {
    expect(normalizeServerUrl(' https://barbarian.example-vpn:5150/ ')).toBe('https://barbarian.example-vpn:5150');
    expect(normalizeServerUrl('')).toBe(defaultServerUrl);
  });

  it('rejects unsafe or unusable destinations', () => {
    expect(() => normalizeServerUrl('http://0.0.0.0:4142')).toThrow('host name or VPN address');
    expect(() => normalizeServerUrl('file:///tmp/barbarian')).toThrow('http:// or https://');
    expect(() => normalizeServerUrl('http://localhost:4142/api')).toThrow('without a path');
  });
});
