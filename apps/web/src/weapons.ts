export const weaponOptions = [
  { id: 'double-axe', label: 'Double axe' },
  { id: 'sword', label: 'Sword' },
  { id: 'crossed-swords', label: 'Crossed swords' },
  { id: 'single-axe', label: 'Single axe' },
  { id: 'mace', label: 'Mace' },
  { id: 'flail', label: 'Flail' },
  { id: 'nunchucks', label: 'Nunchucks' },
  { id: 'hammer', label: 'Hammer' },
] as const;

export type Weapon = typeof weaponOptions[number]['id'];

const weaponIds = new Set<string>(weaponOptions.map(({ id }) => id));

export function normalizeWeapon(value: unknown): Weapon {
  return typeof value === 'string' && weaponIds.has(value) ? value as Weapon : 'double-axe';
}

export function weaponAssetPath(weapon: Weapon): string {
  return `/weapons/${weapon}.svg`;
}

export function weaponFaviconPath(weapon: Weapon): string {
  return weapon === 'double-axe' ? '/favicon.svg' : `/weapons/favicons/${weapon}.svg`;
}
