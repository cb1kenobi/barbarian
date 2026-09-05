import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class ProcessExecutionError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export class CappedOutput {
  private value = '';
  private dropped = 0;

  constructor(private readonly limit: number) {}

  append(chunk: string): void {
    this.value += chunk;
    if (this.value.length <= this.limit) return;
    const excess = this.value.length - this.limit;
    this.value = this.value.slice(excess);
    this.dropped += excess;
  }

  result(): string {
    return this.dropped ? `[... ${this.dropped} characters omitted ...]\n${this.value}` : this.value;
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    timeoutMs?: number;
    maxOutputCharacters?: number;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const reason = options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error(String(options.signal.reason || 'Stopped by user'));
      const error = new ProcessExecutionError(reason.message, '', '');
      error.name = 'AbortError';
      reject(error);
      return;
    }
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      detached,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const processGroupId = child.pid;
    const stdout = new CappedOutput(options.maxOutputCharacters ?? 512_000);
    const stderr = new CappedOutput(options.maxOutputCharacters ?? 512_000);
    const executionError = (error: Error) => {
      const wrapped = new ProcessExecutionError(error.message, stdout.result(), stderr.result());
      wrapped.name = error.name;
      wrapped.cause = error;
      if (error.stack) wrapped.stack = `${wrapped.name}: ${wrapped.message}\nCaused by: ${error.stack}`;
      return wrapped;
    };
    let settled = false;
    let terminalError: Error | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const killProcessTree = (signal: NodeJS.Signals) => {
      if (!processGroupId) return;
      if (detached) {
        try { process.kill(-processGroupId, signal); return; }
        catch {}
      }
      try { child.kill(signal); } catch {}
    };
    const terminate = (error: Error) => {
      if (settled || terminalError) return;
      terminalError = error;
      killProcessTree('SIGTERM');
      forceKillTimer = setTimeout(() => killProcessTree('SIGKILL'), 5_000);
      forceKillTimer.unref();
    };
    const abort = () => {
      const reason = options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error(String(options.signal?.reason || 'Stopped by user'));
      const error = executionError(reason);
      error.name = 'AbortError';
      terminate(error);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(() => {
      terminate(new ProcessExecutionError(
        `${command} timed out after ${options.timeoutMs ?? 120_000}ms`, stdout.result(), stderr.result(),
      ));
    }, options.timeoutMs ?? 120_000);

    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', abort);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout.append(chunk); });
    child.stderr.on('data', (chunk: string) => { stderr.append(chunk); });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE' && !settled) {
        terminate(executionError(error));
      }
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(executionError(error));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (terminalError) killProcessTree('SIGKILL');
      cleanup();
      if (terminalError) {
        reject(terminalError);
        return;
      }
      resolve({ stdout: stdout.result(), stderr: stderr.result(), exitCode: code ?? 1 });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function resolveExecutable(command: string): Promise<string | null> {
  const candidates = command.includes('/')
    ? [path.resolve(command)]
    : (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export async function runJson<T>(command: string, args: string[], timeoutMs?: number): Promise<T> {
  const result = await runProcess(command, args, timeoutMs === undefined ? {} : { timeoutMs });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${command} exited ${result.exitCode}`);
  return JSON.parse(result.stdout) as T;
}
