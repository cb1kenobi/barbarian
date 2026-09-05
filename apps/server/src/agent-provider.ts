import path from 'node:path';
import type { AgentProviderConfig } from './types.js';

export interface AgentProviderCapabilities {
  model: boolean;
  effort: boolean;
}

export type ProviderFamily = 'codex' | 'claude' | 'cursor' | 'gemini' | 'unknown';

export function agentProviderFamily(command: string): ProviderFamily {
  const executable = path.basename(command).toLowerCase().replace(/\.(?:cmd|exe)$/i, '');
  if (executable === 'cursor-agent') return 'cursor';
  if (executable === 'codex' || executable === 'claude' || executable === 'gemini') return executable;
  return 'unknown';
}

export function agentProviderCapabilities(command: string): AgentProviderCapabilities {
  const family = agentProviderFamily(command);
  return {
    model: family !== 'unknown',
    effort: family === 'codex' || family === 'claude',
  };
}

export function agentProviderSupportsWorkspaceWrite(command: string): boolean {
  const family = agentProviderFamily(command);
  return family === 'codex' || family === 'cursor';
}

const environmentReference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

const sensitiveEnvironmentName = /^(?:(?:ANTHROPIC|AWS|AZURE|CLAUDE|CODEX|CURSOR|GEMINI|GOOGLE|OPENAI)_|DATABASE_URL$)|(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_KEY(?:_ID)?|SECRET(?:_ACCESS_KEY)?|PASSWORD|TOKEN|CREDENTIALS?|COOKIE|DSN)$/i;

function inheritedProviderSecrets(command: string): Set<string> {
  switch (agentProviderFamily(command)) {
    case 'claude': return new Set([
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR',
      'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION',
      'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'CLOUD_ML_REGION',
    ]);
    case 'codex': return new Set(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME']);
    case 'cursor': return new Set(['CURSOR_API_KEY']);
    case 'gemini': return new Set([
      'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT',
    ]);
    default: return new Set();
  }
}

export function agentProviderEnvironment(
  provider: AgentProviderConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inheritedSecrets = inheritedProviderSecrets(provider.command);
  const environment = Object.fromEntries(Object.entries(base).filter(([name]) => (
    !sensitiveEnvironmentName.test(name) || inheritedSecrets.has(name)
  )));
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
    delete environment[name];
  }
  for (const [name, configured] of Object.entries(provider.env || {})) {
    const reference = configured.match(environmentReference)?.[1];
    const value = reference ? base[reference] : configured;
    if (reference && reference !== name && sensitiveEnvironmentName.test(reference)) {
      delete environment[reference];
    }
    if (value === undefined) delete environment[name];
    else environment[name] = value;
  }
  if (environment.CLAUDE_CODE_OAUTH_TOKEN) {
    if (!Object.hasOwn(provider.env || {}, 'ANTHROPIC_AUTH_TOKEN')) delete environment.ANTHROPIC_AUTH_TOKEN;
    if (!Object.hasOwn(provider.env || {}, 'ANTHROPIC_API_KEY')) delete environment.ANTHROPIC_API_KEY;
  }
  return environment;
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

export function agentInvocationArgs(
  provider: AgentProviderConfig,
  invocation: { workspaceWrite?: boolean } = {},
): string[] {
  const family = agentProviderFamily(provider.command);
  let args = [...provider.args];
  const options: string[] = [];
  const model = provider.model?.trim();
  if (invocation.workspaceWrite && family === 'codex') {
    args = withoutOption(args, ['--sandbox', '-s']);
    options.push(
      '--sandbox', 'workspace-write',
      '-c', 'project_doc_max_bytes=0',
      '-c', 'project_doc_fallback_filenames=[]',
    );
  } else if (invocation.workspaceWrite && family === 'cursor') {
    args = withoutOption(args, ['--mode']);
    args = args.filter((argument) => argument !== '--plan');
  }
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
