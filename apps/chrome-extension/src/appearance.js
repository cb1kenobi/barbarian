const themes = new Set(['light', 'dark', 'slayer']);
const fontSizes = new Set(['small', 'normal']);

export function normalizeAppearance(value) {
  return {
    theme: themes.has(value?.theme) ? value.theme : 'dark',
    fontSize: fontSizes.has(value?.fontSize) ? value.fontSize : 'normal',
  };
}

export function applyAppearance(value, root = document.documentElement) {
  const appearance = normalizeAppearance(value);
  root.dataset.theme = appearance.theme;
  root.dataset.fontSize = appearance.fontSize;
  root.style.colorScheme = appearance.theme === 'light' ? 'light' : 'dark';
  return appearance;
}
