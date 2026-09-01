import { describe, expect, it } from 'vitest';
import { applyAppearance, normalizeAppearance } from './appearance.js';

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
      dataset: { theme: 'light', fontSize: 'normal' },
      style: { colorScheme: 'light' },
    });
  });

  it('uses safe defaults for missing or invalid server values', () => {
    expect(normalizeAppearance({ theme: 'unknown', fontSize: 'huge' }))
      .toEqual({ theme: 'dark', fontSize: 'normal' });
  });
});
