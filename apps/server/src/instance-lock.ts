import { open, readFile, stat, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from './paths.js';

const execFileAsync = promisify(execFile);

export function commandLooksLikeBarbarian(command: string): boolean {
  return /(?:^|[\s/])(?:dist\/server\/index\.js|apps\/server\/src\/index\.ts)(?:\s|$)/i.test(command);
}

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

async function processOwnsLock(pid: number, lockStartedAt: string | undefined): Promise<boolean> {
  if (!processExists(pid)) return false;
  if (pid === process.pid) return true;
  try {
    if (lockStartedAt) {
      const lockTime = Date.parse(lockStartedAt);
      const processTime = Date.parse((await execFileAsync('ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim());
      if (Number.isFinite(lockTime) && Number.isFinite(processTime)) {
        return processTime <= lockTime + 2_000;
      }
    }
    const command = process.platform === 'linux'
      ? (await readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ')
      : (await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])).stdout;
    return commandLooksLikeBarbarian(command);
  } catch {
    return true;
  }
}

export async function acquireInstanceLock(
  filename = paths.lockPath,
  ownsLock: (pid: number, startedAt: string | undefined) => Promise<boolean> = processOwnsLock,
): Promise<InstanceLock> {
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
      const owner: { pid?: number; startedAt?: string } = await readFile(filename, 'utf8')
        .then((value) => JSON.parse(value) as { pid?: number; startedAt?: string })
        .catch(() => ({}));
      if (owner.pid && await ownsLock(owner.pid, owner.startedAt)) {
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
