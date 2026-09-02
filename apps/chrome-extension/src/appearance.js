const themes = new Set(['light', 'dark', 'slayer']);
const fontSizes = new Set(['small', 'normal']);
const weapons = new Set(['double-axe', 'sword', 'crossed-swords', 'single-axe', 'mace', 'flail', 'nunchucks', 'hammer']);
export const appearanceStorageKey = 'barbarian.appearance';

export function normalizeAppearance(value) {
  return {
    theme: themes.has(value?.theme) ? value.theme : 'dark',
    fontSize: fontSizes.has(value?.fontSize) ? value.fontSize : 'normal',
    weapon: weapons.has(value?.weapon) ? value.weapon : 'double-axe',
  };
}

export function applyAppearance(value, root = document.documentElement) {
  const appearance = normalizeAppearance(value);
  root.dataset.theme = appearance.theme;
  root.dataset.fontSize = appearance.fontSize;
  root.dataset.weapon = appearance.weapon;
  root.dataset.appearance = 'ready';
  root.style.colorScheme = appearance.theme === 'light' ? 'light' : 'dark';
  return appearance;
}

export async function rememberAppearance(value, storage) {
  const appearance = normalizeAppearance(value);
  try { await storage.set({ [appearanceStorageKey]: appearance }); }
  catch {}
  return appearance;
}

export async function restoreAppearance(storage, root = document.documentElement) {
  try {
    const stored = await storage.get(appearanceStorageKey);
    if (stored?.[appearanceStorageKey]) return applyAppearance(stored[appearanceStorageKey], root);
  } catch {}
  return null;
}
