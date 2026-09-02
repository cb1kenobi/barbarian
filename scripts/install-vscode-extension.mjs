#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extensionDirectory = path.join(root, 'apps/vscode-extension');
const manifest = JSON.parse(await readFile(path.join(extensionDirectory, 'package.json'), 'utf8'));
const vsix = path.join(extensionDirectory, `${manifest.name}-${manifest.version}.vsix`);
const windows = process.platform === 'win32';

function run(command, arguments_, cwd = root) {
  const result = spawnSync(windows ? `${command}.cmd` : command, arguments_, {
    cwd,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['run', 'build'], extensionDirectory);
run('pnpm', ['run', 'package'], extensionDirectory);
await access(vsix);
run('code', ['--install-extension', vsix, '--force']);
