import { describe, expect, it } from 'vitest';
import {
  appearanceStorageKey, applyAppearance, normalizeAppearance, rememberAppearance, restoreAppearance,
} from './appearance.js';

describe('Chrome extension appearance', () => {
  it('accepts every app theme and font size', () => {
    expect(normalizeAppearance({ theme: 'slayer', fontSize: 'small', weapon: 'mace' }))
      .toEqual({ theme: 'slayer', fontSize: 'small', weapon: 'mace' });
    expect(normalizeAppearance({ theme: 'light', fontSize: 'normal', weapon: 'crossed-swords' }))
      .toEqual({ theme: 'light', fontSize: 'normal', weapon: 'crossed-swords' });
  });

  it('applies normalized appearance to the panel root', () => {
    const root = { dataset: {}, style: {} };
    expect(applyAppearance({ theme: 'light', fontSize: 'normal', weapon: 'hammer' }, root)).toEqual({
      theme: 'light', fontSize: 'normal', weapon: 'hammer',
    });
    expect(root).toEqual({
      dataset: { theme: 'light', fontSize: 'normal', weapon: 'hammer', appearance: 'ready' },
      style: { colorScheme: 'light' },
    });
  });

  it('uses safe defaults for missing or invalid server values', () => {
    expect(normalizeAppearance({ theme: 'unknown', fontSize: 'huge', weapon: 'lightsaber' }))
      .toEqual({ theme: 'dark', fontSize: 'normal', weapon: 'double-axe' });
  });

  it('persists and restores the last server-confirmed appearance', async () => {
    const values = {};
    const storage = {
      async get(key) { return { [key]: values[key] }; },
      async set(next) { Object.assign(values, next); },
    };
    const root = { dataset: {}, style: {} };

    await rememberAppearance({ theme: 'slayer', fontSize: 'small', weapon: 'single-axe' }, storage);
    expect(values[appearanceStorageKey]).toEqual({ theme: 'slayer', fontSize: 'small', weapon: 'single-axe' });
    expect(await restoreAppearance(storage, root)).toEqual({ theme: 'slayer', fontSize: 'small', weapon: 'single-axe' });
    expect(root.dataset).toEqual({ theme: 'slayer', fontSize: 'small', weapon: 'single-axe', appearance: 'ready' });
  });

  it('leaves the current theme alone when no saved appearance exists', async () => {
    const root = { dataset: { theme: 'slayer', fontSize: 'normal' }, style: { colorScheme: 'dark' } };
    expect(await restoreAppearance({ async get() { return {}; } }, root)).toBeNull();
    expect(root.dataset.theme).toBe('slayer');
  });
});
