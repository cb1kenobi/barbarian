import { open, readFile, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from './paths.js';

const execFileAsync = promisify(execFile);

export interface InstanceLock {
  release(): Promise<void>;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function processIsBarbarian(pid: number): Promise<boolean> {
  if (!processExists(pid)) return false;
  if (pid === process.pid) return true;
  try {
    const command = process.platform === 'linux'
      ? (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ')
      : (await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])).stdout;
    return /(?:^|\s)\S*barbarian\S*\/dist\/server\/index\.js(?:\s|$)/i.test(command);
  } catch {
    return process.platform !== 'darwin' && process.platform !== 'linux';
  }
}

export async function acquireInstanceLock(filename = paths.lockPath): Promise<InstanceLock> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const handle = await open(filename, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      return {
        async release() {
          await handle.close().catch(() => undefined);
          await unlink(filename).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const observed = await stat(filename).catch(() => null);
      const owner: { pid?: number } = await readFile(filename, 'utf8')
        .then((value) => JSON.parse(value) as { pid?: number })
        .catch(() => ({}));
      if (owner.pid && await processIsBarbarian(owner.pid)) {
        throw new Error(`Barbarian is already running as process ${owner.pid}`);
      }
      if (!owner.pid && observed && Date.now() - observed.mtimeMs < 30_000) {
        throw new Error('Barbarian is already starting');
      }
      const current = await stat(filename).catch(() => null);
      if (!observed || !current || observed.ino !== current.ino) continue;
      await unlink(filename).catch(() => undefined);
    }
  }
  throw new Error('Could not acquire the Barbarian instance lock');
}
