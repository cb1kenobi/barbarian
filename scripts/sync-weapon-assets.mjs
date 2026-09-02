import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceDirectory = path.join(root, 'assets/branding/weapons');
const webDirectory = path.join(root, 'apps/web/public/weapons');
const chromeDirectory = path.join(root, 'apps/chrome-extension/icons/weapons');
const vscodeDirectory = path.join(root, 'apps/vscode-extension/media/weapons');
const faviconDirectory = path.join(webDirectory, 'favicons');
const weapons = ['double-axe', 'sword', 'crossed-swords', 'single-axe', 'mace', 'flail', 'nunchucks', 'hammer'];

await Promise.all([webDirectory, chromeDirectory, vscodeDirectory, faviconDirectory].map((directory) => mkdir(directory, { recursive: true })));

await Promise.all(weapons.flatMap((weapon) => {
  const source = path.join(sourceDirectory, `${weapon}.svg`);
  return [
    copyFile(source, path.join(webDirectory, `${weapon}.svg`)),
    copyFile(source, path.join(chromeDirectory, `${weapon}.svg`)),
    copyFile(source, path.join(vscodeDirectory, `${weapon}.svg`)),
    readFile(source, 'utf8').then((svg) => {
      const body = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>/)?.[1]?.replace(/<title[^>]*>[\s\S]*?<\/title>/g, '') || '';
      const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Barbarian ${weapon}">\n  <rect width="64" height="64" rx="8" fill="#0d0e0c"/>\n  <g color="#ff554d" transform="translate(5.76 5.76) scale(.82)">${body.trim()}</g>\n</svg>\n`;
      return writeFile(path.join(faviconDirectory, `${weapon}.svg`), favicon);
    }),
  ];
}));

console.log(`Synced ${weapons.length} weapon marks for the web, Chrome, and VS Code.`);
