import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const source = path.resolve('assets/branding/barbarian-app-icon.png');
const output = path.resolve('dist/desktop/Barbarian.icns');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'barbarian-icon-'));
const iconset = path.join(temporary, 'Barbarian.iconset');
await execute('mkdir', ['-p', iconset]);
for (const size of [16, 32, 128, 256, 512]) {
  await execute('sips', ['-z', String(size), String(size), source, '--out', path.join(iconset, `icon_${size}x${size}.png`)]);
  await execute('sips', ['-z', String(size * 2), String(size * 2), source, '--out', path.join(iconset, `icon_${size}x${size}@2x.png`)]);
}
await execute('iconutil', ['-c', 'icns', iconset, '-o', output]);
await rm(temporary, { recursive: true, force: true });
