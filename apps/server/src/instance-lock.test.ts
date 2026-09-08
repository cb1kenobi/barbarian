import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, commandLooksLikeBarbarian } from './instance-lock.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('acquireInstanceLock', () => {
  it('rejects a second live owner and permits acquisition after release', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-lock-'));
    directories.push(directory);
    const filename = path.join(directory, 'barbarian.lock');
    const first = await acquireInstanceLock(filename);
    await expect(acquireInstanceLock(filename)).rejects.toThrow('already running');
    await first.release();
    const second = await acquireInstanceLock(filename);
    await second.release();
  });

  it('reclaims a lock whose PID was reused by an unrelated process', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-lock-'));
    directories.push(directory);
    const filename = path.join(directory, 'barbarian.lock');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)']);
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    try {
      await writeFile(filename, JSON.stringify({ pid: child.pid, startedAt: '2020-01-01T00:00:00Z' }));
      const lock = await acquireInstanceLock(filename, async () => false);
      await lock.release();
    } finally {
      child.kill();
    }
  });

  it('recognizes production and development server entrypoints', () => {
    expect(commandLooksLikeBarbarian('node /projects/barbarian/dist/server/index.js')).toBe(true);
    expect(commandLooksLikeBarbarian('tsx watch apps/server/src/index.ts')).toBe(true);
    expect(commandLooksLikeBarbarian('node -e setInterval(() => undefined, 1000)')).toBe(false);
  });
});
