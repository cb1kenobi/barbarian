import path from 'node:path';
import type { AgentProviderConfig } from './types.js';

export interface AgentProviderCapabilities {
  model: boolean;
  effort: boolean;
}

type ProviderFamily = 'codex' | 'claude' | 'gemini' | 'unknown';

function providerFamily(command: string): ProviderFamily {
  const executable = path.basename(command).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  if (executable === 'codex' || executable === 'claude' || executable === 'gemini') return executable;
  return 'unknown';
}

export function agentProviderCapabilities(command: string): AgentProviderCapabilities {
  const family = providerFamily(command);
  return {
    model: family !== 'unknown',
    effort: family === 'codex' || family === 'claude',
  };
}

function withoutOption(args: string[], names: string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (names.includes(argument)) {
      index += 1;
      continue;
    }
    if (names.some((name) => argument.startsWith(`${name}=`))) continue;
    filtered.push(argument);
  }
  return filtered;
}

function withoutCodexEffort(args: string[]): string[] {
  const filtered: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = (argument === '-c' || argument === '--config') ? args[index + 1] : undefined;
    if (value?.startsWith('model_reasoning_effort=')) {
      index += 1;
      continue;
    }
    filtered.push(argument);
  }
  return filtered;
}

function beforeStdinPrompt(args: string[], options: string[]): string[] {
  if (args.at(-1) !== '-') return [...args, ...options];
  return [...args.slice(0, -1), ...options, '-'];
}

export function agentInvocationArgs(provider: AgentProviderConfig): string[] {
  const family = providerFamily(provider.command);
  let args = [...provider.args];
  const options: string[] = [];
  const model = provider.model?.trim();
  if (model && family !== 'unknown') {
    args = withoutOption(args, ['--model', '-m']);
    options.push('--model', model);
  }
  if (provider.effort && family === 'codex') {
    args = withoutCodexEffort(args);
    options.push('-c', `model_reasoning_effort="${provider.effort}"`);
  } else if (provider.effort && family === 'claude') {
    args = withoutOption(args, ['--effort']);
    options.push('--effort', provider.effort);
  }
  return beforeStdinPrompt(args, options);
}
