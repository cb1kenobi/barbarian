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
    const controller = new AbortController();
    const running = runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      signal: controller.signal,
    });
    controller.abort(new Error('Stopped by user'));
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  });
});
