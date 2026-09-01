import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime.js';

describe('AgentRuntime concurrency changes', () => {
  it('starts queued work when the configured limit increases', async () => {
    const runtime = new AgentRuntime(1);
    let releaseFirst!: () => void;
    let secondStarted = false;
    const first = runtime.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
    const second = runtime.run(async () => { secondStarted = true; });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    runtime.setMaxConcurrent(2);
    await Promise.resolve();
    expect(secondStarted).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
  });
});
