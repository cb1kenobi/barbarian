import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.content_scripts?.length || !manifest.background?.service_worker) {
  throw new Error('Invalid Chrome extension manifest');
}
await readFile(new URL(`../${manifest.background.service_worker}`, import.meta.url), 'utf8');
if (!manifest.side_panel?.default_path || !manifest.permissions?.includes('sidePanel')) {
  throw new Error('Chrome extension must declare its native side panel');
}
if (!manifest.options_page) throw new Error('Chrome extension must provide connection settings');
const optionsHtml = await readFile(new URL(`../${manifest.options_page}`, import.meta.url), 'utf8');
const panelHtml = await readFile(new URL(`../${manifest.side_panel.default_path}`, import.meta.url), 'utf8');
for (const html of [panelHtml, optionsHtml]) {
  for (const match of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
    await readFile(new URL(`../src/${match[1]}`, import.meta.url), 'utf8');
  }
}
for (const contentScript of manifest.content_scripts) {
  for (const source of contentScript.js || []) await readFile(new URL(`../${source}`, import.meta.url), 'utf8');
}
for (const icon of Object.values(manifest.icons || {})) await readFile(new URL(`../${icon}`, import.meta.url));
for (const weapon of ['double-axe', 'sword', 'crossed-swords', 'single-axe', 'mace', 'flail', 'nunchucks', 'hammer']) {
  await readFile(new URL(`../icons/weapons/${weapon}.svg`, import.meta.url), 'utf8');
}
if (!process.argv.includes('--quiet')) {
  console.log('Chrome extension manifest is valid. Load apps/chrome-extension as an unpacked extension.');
}
