import { spawn } from 'node:child_process';
import type { AgentProviderConfig } from './types.js';
import { agentProviderEnvironment, agentProviderFamily } from './agent-provider.js';
import { CappedOutput, resolveExecutable, runProcess } from './process.js';

export interface AgentProviderUsage {
  usedPercent: number | null;
  error?: string;
}

function percentage(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

export function parseUsageOutput(source: string): number | null {
  const trimmed = source.trim();
  const numeric = Number(trimmed.replace(/%$/, ''));
  if (trimmed && Number.isFinite(numeric)) return percentage(numeric);
  try {
    const parsed = JSON.parse(trimmed) as { usedPercent?: unknown; utilization?: unknown };
    return percentage(parsed.usedPercent) ?? percentage(parsed.utilization);
  } catch {
    return null;
  }
}

export function usagePercentFromPayload(value: unknown): number | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const direct = percentage(record.usedPercent) ?? percentage(record.utilization);
  const children = Object.values(record).map(usagePercentFromPayload).filter((item): item is number => item !== null);
  return [direct, ...children].filter((item): item is number => item !== null)
    .reduce<number | null>((maximum, item) => maximum === null ? item : Math.max(maximum, item), null);
}

async function commandUsage(provider: AgentProviderConfig): Promise<AgentProviderUsage> {
  const [configuredCommand, ...args] = provider.usageCommand || [];
  if (!configuredCommand) return { usedPercent: null };
  const command = await resolveExecutable(configuredCommand);
  if (!command) return { usedPercent: null, error: `Usage command "${configuredCommand}" was not found` };
  const result = await runProcess(command, args, {
    timeoutMs: 15_000,
    maxOutputCharacters: 100_000,
    env: agentProviderEnvironment(provider),
  });
  if (result.exitCode !== 0) {
    return { usedPercent: null, error: `Usage command exited ${result.exitCode}` };
  }
  const usedPercent = parseUsageOutput(result.stdout);
  return usedPercent === null
    ? { usedPercent: null, error: 'Usage command did not return a percentage' }
    : { usedPercent };
}

async function claudeUsage(
  provider: AgentProviderConfig,
  request: typeof fetch,
): Promise<AgentProviderUsage> {
  const environment = agentProviderEnvironment(provider);
  const token = environment.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return { usedPercent: null, error: 'Usage unavailable without CLAUDE_CODE_OAUTH_TOKEN' };
  const response = await request('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'barbarian/0.1',
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return { usedPercent: null, error: `Claude usage check returned ${response.status}` };
  const usedPercent = usagePercentFromPayload(await response.json());
  return usedPercent === null
    ? { usedPercent: null, error: 'Claude usage response did not include utilization' }
    : { usedPercent };
}

async function codexUsage(provider: AgentProviderConfig): Promise<AgentProviderUsage> {
  const command = await resolveExecutable(provider.command);
  if (!command) return { usedPercent: null, error: `Agent command "${provider.command}" was not found` };
  const response = await new Promise<{ result?: unknown; error?: { message?: unknown } }>((resolve, reject) => {
    const child = spawn(command, ['app-server', '--stdio'], {
      env: agentProviderEnvironment(provider), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const stderr = new CappedOutput(100_000);
    let settled = false;
    let stopping = false;
    let terminalError: Error | undefined;
    let terminalValue: { result?: unknown; error?: { message?: unknown } } | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let hardStopTimer: NodeJS.Timeout | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (terminalError) reject(terminalError);
      else if (terminalValue) resolve(terminalValue);
      else reject(new Error(stderr.result().trim() || 'Codex usage check stopped without a result'));
    };
    const stop = (error?: Error, value?: { result?: unknown; error?: { message?: unknown } }) => {
      if (stopping || settled) return;
      stopping = true;
      terminalError = error;
      terminalValue = value;
      clearTimeout(timeout);
      try { child.kill('SIGTERM'); } catch {}
      forceKillTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        hardStopTimer = setTimeout(settle, 2_000);
        hardStopTimer.unref();
      }, 1_000);
      forceKillTimer.unref();
    };
    const timeout = setTimeout(() => stop(new Error('Codex usage check timed out')), 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr.append(chunk); });
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 100_000 && !buffer.includes('\n')) {
        stop(new Error('Codex usage response contained an oversized JSON line'));
        return;
      }
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
        try { message = JSON.parse(line) as typeof message; } catch { continue; }
        if (message.id === 1) {
          if (message.error) {
            stop(new Error(String(message.error.message || 'Codex initialization failed')));
            return;
          }
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: null })}\n`);
        } else if (message.id === 2) {
          stop(undefined, message);
          return;
        }
      }
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(error);
    });
    child.on('error', (error) => stop(error));
    child.on('close', (code) => {
      if (settled) return;
      if (!terminalError && !terminalValue) {
        terminalError = new Error(stderr.result().trim() || `Codex usage check exited ${code ?? 1}`);
      }
      settle();
    });
    child.stdin.write(`${JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'barbarian', version: '0.1.0' }, capabilities: { experimentalApi: true } },
    })}\n`);
  });
  if (response.error) return { usedPercent: null, error: String(response.error.message || 'Codex usage check failed') };
  const usedPercent = usagePercentFromPayload(response.result);
  return usedPercent === null
    ? { usedPercent: null, error: 'Codex usage response did not include rate limits' }
    : { usedPercent };
}

export async function readAgentProviderUsage(
  provider: AgentProviderConfig,
  options: { request?: typeof fetch } = {},
): Promise<AgentProviderUsage> {
  try {
    if (provider.usageCommand?.length) return await commandUsage(provider);
    const family = agentProviderFamily(provider.command);
    if (family === 'claude') return await claudeUsage(provider, options.request || fetch);
    if (family === 'codex') return await codexUsage(provider);
    return { usedPercent: null, error: 'This provider does not expose usage limits' };
  } catch (error) {
    return { usedPercent: null, error: error instanceof Error ? error.message : String(error) };
  }
}
