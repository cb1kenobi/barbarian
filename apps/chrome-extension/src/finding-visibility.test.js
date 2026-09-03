import { describe, expect, it } from 'vitest';
import {
  rememberSuppressResolved, restoreSuppressResolved, suppressResolvedStorageKey, visibleFindings,
} from './finding-visibility.js';

describe('Chrome extension finding visibility', () => {
  const findings = [
    { id: 'open', resolved: false, outdated: false },
    { id: 'resolved', resolved: true, outdated: false },
    { id: 'outdated', resolved: false, outdated: true },
  ];

  it('shows every finding until resolved findings are suppressed', () => {
    expect(visibleFindings(findings, false)).toEqual(findings);
    expect(visibleFindings(findings, true).map(({ id }) => id)).toEqual(['open', 'outdated']);
  });

  it('persists and restores the preference', async () => {
    const values = {};
    const storage = {
      async get(key) { return { [key]: values[key] }; },
      async set(next) { Object.assign(values, next); },
    };

    expect(await restoreSuppressResolved(storage)).toBe(false);
    await rememberSuppressResolved(true, storage);
    expect(values[suppressResolvedStorageKey]).toBe(true);
    expect(await restoreSuppressResolved(storage)).toBe(true);
  });

  it('falls back to showing resolved findings when storage is unavailable', async () => {
    const storage = {
      async get() { throw new Error('unavailable'); },
      async set() { throw new Error('unavailable'); },
    };

    expect(await restoreSuppressResolved(storage)).toBe(false);
    expect(await rememberSuppressResolved('true', storage)).toBe(false);
  });
});
