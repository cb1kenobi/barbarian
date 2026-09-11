import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
if (process.platform !== 'darwin') process.exit(0);
const source = path.resolve('assets/branding/barbarian-app-icon.png');
const output = path.resolve('dist/desktop/Barbarian.icns');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'barbarian-icon-'));
const iconset = path.join(temporary, 'Barbarian.iconset');

// iconutil on macOS 26 can reject complete iconsets, including iconsets it just
// exported. ICNS is a simple chunked container, so package the PNG slots
// directly instead of making desktop builds depend on that conversion.
const slots = [
  ['icp4', 16, 'icon_16x16.png'],
  ['ic11', 32, 'icon_16x16@2x.png'],
  ['icp5', 32, 'icon_32x32.png'],
  ['ic12', 64, 'icon_32x32@2x.png'],
  ['ic07', 128, 'icon_128x128.png'],
  ['ic13', 256, 'icon_128x128@2x.png'],
  ['ic08', 256, 'icon_256x256.png'],
  ['ic14', 512, 'icon_256x256@2x.png'],
  ['ic09', 512, 'icon_512x512.png'],
  ['ic10', 1024, 'icon_512x512@2x.png'],
];

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(header.length + data.length, 4);
  return Buffer.concat([header, data]);
}

try {
  await mkdir(iconset);
  for (const [, pixels, filename] of slots) {
    await execute('sips', ['-z', String(pixels), String(pixels), source, '--out', path.join(iconset, filename)]);
  }

  const chunks = await Promise.all(slots.map(async ([type, , filename]) => chunk(type, await readFile(path.join(iconset, filename)))));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + chunks.reduce((length, value) => length + value.length, 0), 4);
  await writeFile(output, Buffer.concat([header, ...chunks]));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
