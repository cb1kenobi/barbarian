import { describe, expect, it } from 'vitest';
import { normalizeWeapon, weaponAssetPath, weaponFaviconPath, weaponOptions } from './weapons';

describe('weapon branding helpers', () => {
  it('accepts every selectable weapon', () => {
    for (const { id } of weaponOptions) expect(normalizeWeapon(id)).toBe(id);
  });

  it('keeps the primary double axe as the safe default', () => {
    expect(normalizeWeapon(undefined)).toBe('double-axe');
    expect(normalizeWeapon('lightsaber')).toBe('double-axe');
  });

  it('uses the primary favicon for the double axe and generated variants otherwise', () => {
    expect(weaponAssetPath('mace')).toBe('/weapons/mace.svg');
    expect(weaponFaviconPath('double-axe')).toBe('/favicon.svg');
    expect(weaponFaviconPath('hammer')).toBe('/weapons/favicons/hammer.svg');
  });
});
