import { readFile } from 'node:fs/promises';
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
if (manifest.manifest_version !== 3 || !manifest.content_scripts?.length) throw new Error('Invalid Chrome extension manifest');
console.log('Chrome extension manifest is valid. Load apps/chrome-extension as an unpacked extension.');

