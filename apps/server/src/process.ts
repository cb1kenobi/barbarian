import { spawn } from 'node:child_process';

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string; input?: string; timeoutMs?: number } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${options.timeoutMs ?? 120_000}ms`));
      }
    }, options.timeoutMs ?? 120_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export async function runJson<T>(command: string, args: string[], timeoutMs?: number): Promise<T> {
  const result = await runProcess(command, args, timeoutMs === undefined ? {} : { timeoutMs });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${command} exited ${result.exitCode}`);
  return JSON.parse(result.stdout) as T;
}
