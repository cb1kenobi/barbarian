import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runProcess } from './process.js';

describe('runProcess', () => {
  it('caps retained output while preserving the tail', async () => {
    const result = await runProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(5000)+'TAIL')"], {
      maxOutputCharacters: 100,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('characters omitted');
    expect(result.stdout.endsWith('TAIL')).toBe(true);
    expect(result.stdout.length).toBeLessThan(180);
  });

  it('terminates a spawned process when its agent signal is cancelled', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-process-tree-test-'));
    const marker = path.join(directory, 'survived');
    try {
      const controller = new AbortController();
      const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 350)`;
      const parent = `require('node:child_process').spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
      const running = runProcess(process.execPath, ['-e', parent], {
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error('Stopped by user')), 100);
      await expect(running).rejects.toMatchObject({ name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
