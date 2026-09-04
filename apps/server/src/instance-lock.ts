import { open, readFile, stat, unlink } from 'node:fs/promises';
import { paths } from './paths.js';

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
      if (owner.pid && processExists(owner.pid)) {
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
