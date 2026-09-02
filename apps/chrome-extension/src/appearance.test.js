import { describe, expect, it } from 'vitest';
import {
  appearanceStorageKey, applyAppearance, normalizeAppearance, rememberAppearance, restoreAppearance,
} from './appearance.js';

describe('Chrome extension appearance', () => {
  it('accepts every app theme and font size', () => {
    expect(normalizeAppearance({ theme: 'slayer', fontSize: 'small' }))
      .toEqual({ theme: 'slayer', fontSize: 'small' });
    expect(normalizeAppearance({ theme: 'light', fontSize: 'normal' }))
      .toEqual({ theme: 'light', fontSize: 'normal' });
  });

  it('applies normalized appearance to the panel root', () => {
    const root = { dataset: {}, style: {} };
    expect(applyAppearance({ theme: 'light', fontSize: 'normal' }, root)).toEqual({
      theme: 'light', fontSize: 'normal',
    });
    expect(root).toEqual({
      dataset: { theme: 'light', fontSize: 'normal', appearance: 'ready' },
      style: { colorScheme: 'light' },
    });
  });

  it('uses safe defaults for missing or invalid server values', () => {
    expect(normalizeAppearance({ theme: 'unknown', fontSize: 'huge' }))
      .toEqual({ theme: 'dark', fontSize: 'normal' });
  });

  it('persists and restores the last server-confirmed appearance', async () => {
    const values = {};
    const storage = {
      async get(key) { return { [key]: values[key] }; },
      async set(next) { Object.assign(values, next); },
    };
    const root = { dataset: {}, style: {} };

    await rememberAppearance({ theme: 'slayer', fontSize: 'small' }, storage);
    expect(values[appearanceStorageKey]).toEqual({ theme: 'slayer', fontSize: 'small' });
    expect(await restoreAppearance(storage, root)).toEqual({ theme: 'slayer', fontSize: 'small' });
    expect(root.dataset).toEqual({ theme: 'slayer', fontSize: 'small', appearance: 'ready' });
  });

  it('leaves the current theme alone when no saved appearance exists', async () => {
    const root = { dataset: { theme: 'slayer', fontSize: 'normal' }, style: { colorScheme: 'dark' } };
    expect(await restoreAppearance({ async get() { return {}; } }, root)).toBeNull();
    expect(root.dataset.theme).toBe('slayer');
  });
});
