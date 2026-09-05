import { describe, expect, it } from 'vitest';
import { parseUsageOutput, readAgentProviderUsage } from './agent-usage.js';

describe('agent provider usage', () => {
  it('parses numeric and JSON usage command output', () => {
    expect(parseUsageOutput('81%')).toBe(81);
    expect(parseUsageOutput('{"usedPercent":42}')).toBe(42);
    expect(parseUsageOutput('{"utilization":19.5}')).toBe(19.5);
    expect(parseUsageOutput('unknown')).toBeNull();
  });

  it('reads the highest Claude subscription window without exposing the token', async () => {
    const previous = process.env.CLAUDE_TEST_TOKEN;
    process.env.CLAUDE_TEST_TOKEN = 'secret-token';
    try {
      const usage = await readAgentProviderUsage({
        command: 'claude', args: ['-p'], env: { CLAUDE_CODE_OAUTH_TOKEN: '${CLAUDE_TEST_TOKEN}' },
      }, {
        request: async (_input, init) => {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret-token');
          return new Response(JSON.stringify({
            five_hour: { utilization: 31 }, seven_day: { utilization: 76 },
          }), { status: 200 });
        },
      });
      expect(usage).toEqual({ usedPercent: 76 });
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_TEST_TOKEN;
      else process.env.CLAUDE_TEST_TOKEN = previous;
    }
  });
});
