import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseUsageOutput, readAgentProviderUsage, usagePercentFromPayload } from './agent-usage.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('agent provider usage', () => {
  it('parses numeric and JSON usage command output', () => {
    expect(parseUsageOutput('81%')).toBe(81);
    expect(parseUsageOutput('{"usedPercent":42}')).toBe(42);
    expect(parseUsageOutput('{"utilization":19.5}')).toBe(19.5);
    expect(parseUsageOutput('unknown')).toBeNull();
  });

  it('reads the highest window from Codex and Claude response shapes', () => {
    expect(usagePercentFromPayload({
      rateLimits: { primary: { usedPercent: 42 }, secondary: { usedPercent: 79 } },
      rateLimitsByLimitId: { codex: { primary: { usedPercent: 64 } } },
    })).toBe(79);
    expect(usagePercentFromPayload({
      five_hour: { utilization: 31 }, seven_day: { utilization: 76 },
    })).toBe(76);
  });

  it('supports a custom usage command for providers without a native probe', async () => {
    expect(await readAgentProviderUsage({
      command: 'custom-reviewer', args: [],
      usageCommand: [process.execPath, '-e', 'console.log(JSON.stringify({ usedPercent: 62 }))'],
    })).toEqual({ usedPercent: 62 });
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

  it('performs the Codex app-server handshake and reads its highest rate limit', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-fake-codex-'));
    directories.push(directory);
    const command = path.join(directory, 'codex');
    writeFileSync(command, `#!/usr/bin/env node
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (message.id === 2) console.log(JSON.stringify({
      id: 2, result: { rateLimits: { primary: { usedPercent: 44 }, secondary: { usedPercent: 73 } } },
    }));
  }
});
setInterval(() => undefined, 1000);
`);
    chmodSync(command, 0o755);
    await expect(readAgentProviderUsage({ command, args: [] })).resolves.toEqual({ usedPercent: 73 });
  });
});
