import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const directory = path.resolve('apps/vscode-extension');
const output = path.resolve('dist/extensions/barbarian-vscode-extension.vsix');
await mkdir(path.dirname(output), { recursive: true });
const executable = path.resolve('apps/vscode-extension/node_modules/.bin/vsce');
await new Promise((resolve, reject) => {
  const child = spawn(executable, ['package', '--allow-missing-repository', '--out', output], {
    cwd: directory,
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`vsce exited with code ${code}`)));
});
