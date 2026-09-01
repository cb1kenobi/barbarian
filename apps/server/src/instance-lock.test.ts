import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock } from './instance-lock.js';

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
});
