import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AgentProviderConfig } from './types.js';
import { agentProviderEnvironment, agentProviderFamily } from './agent-provider.js';

const executeFile = promisify(execFile);
const claudeCache = new Map<string, { expiresAt: number; discovery: AgentModelDiscovery }>();
const cursorCache = new Map<string, { expiresAt: number; discovery: AgentModelDiscovery }>();
const ansiPattern = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g;

export interface AgentModelOption {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface AgentModelDiscovery {
  models: AgentModelOption[];
  defaultModel: string | null;
  error?: string;
}

interface CodexModelRecord {
  slug?: unknown;
  display_name?: unknown;
  visibility?: unknown;
  priority?: unknown;
}

function optionValue(args: string[], names: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] || '';
    if (names.includes(argument) && args[index + 1]) return args[index + 1]!.trim() || null;
    const name = names.find((candidate) => argument.startsWith(`${candidate}=`));
    if (name) return argument.slice(name.length + 1).trim() || null;
  }
  return null;
}

function tomlModel(filename: string): string | null {
  try {
    for (const line of readFileSync(filename, 'utf8').split('\n')) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*model\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
      if (match?.[2]?.trim()) return match[2].trim();
    }
  } catch {}
  return null;
}

function codexDefaultModel(provider: AgentProviderConfig, codexHome: string): string | null {
  const argumentModel = optionValue(provider.args, ['--model', '-m']);
  if (argumentModel) return argumentModel;
  const profile = optionValue(provider.args, ['--profile', '-p']);
  const profileModel = profile && /^[A-Za-z0-9._-]+$/.test(profile) && profile !== '.' && profile !== '..'
    ? tomlModel(path.join(codexHome, `${profile}.config.toml`))
    : null;
  return profileModel
    || tomlModel(path.join(codexHome, 'config.toml'));
}

function codexModels(codexHome: string): Array<Omit<AgentModelOption, 'isDefault'>> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8')) as {
      models?: CodexModelRecord[];
    };
    if (!Array.isArray(parsed.models)) return [];
    return parsed.models
      .filter((model) => typeof model.slug === 'string' && model.slug && model.visibility !== 'hide')
      .sort((left, right) => Number(left.priority ?? Number.MAX_SAFE_INTEGER) - Number(right.priority ?? Number.MAX_SAFE_INTEGER))
      .map((model) => ({
        id: model.slug as string,
        name: typeof model.display_name === 'string' && model.display_name ? model.display_name : model.slug as string,
      }));
  } catch {
    return [];
  }
}

function parseClaudeModels(source: string): AgentModelDiscovery {
  try {
    const payload = JSON.parse(source) as { is_error?: boolean; result?: unknown };
    if (payload.is_error || typeof payload.result !== 'string') return { models: [], defaultModel: null };
    const currentLine = payload.result.match(/^Current model:\s*(.+)$/m)?.[1]?.trim();
    const available = payload.result.match(/Available:\s*(.+)$/m)?.[1]
      ?.replace(/[.]\s*$/, '')
      .replace(/\s+or\s+/g, ',')
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model && model !== 'default' && !model.startsWith('a full model ID')) || [];
    if (!available.length) return { models: [], defaultModel: null };

    const isDefault = Boolean(currentLine?.match(/\s+\(default\)(?:\s+\(effort:[^)]+\))?$/));
    const currentName = currentLine
      ?.replace(/\s+\(effort:[^)]+\)\s*$/, '')
      .replace(/\s+\(default\)\s*$/, '')
      .trim() || null;
    const family = currentName?.match(/\b(sonnet|opus|haiku|fable)\b/i)?.[1]?.toLowerCase();
    const preferredAlias = family && /\b1m context\b/i.test(currentName || '') ? `${family}[1m]` : family;
    const defaultModel = isDefault && preferredAlias && available.includes(preferredAlias)
      ? preferredAlias
      : isDefault ? 'default' : null;
    const models = available.map((id) => ({
      id,
      name: id === defaultModel && currentName ? currentName : id,
      isDefault: id === defaultModel,
    }));
    if (defaultModel === 'default') models.unshift({ id: 'default', name: currentName || 'default', isDefault: true });
    return { models, defaultModel };
  } catch {
    return { models: [], defaultModel: null };
  }
}

export function parseCursorModels(source: string): AgentModelDiscovery {
  const models = source.replace(ansiPattern, '').split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(\S+)\s+-\s+(.+?)\s*$/);
    if (!match?.[1] || !match[2]) return [];
    const markers = match[2].match(/\s+\(([^)]+)\)\s*$/)?.[1]?.split(',').map((value) => value.trim()) || [];
    const cliState = markers.some((marker) => marker === 'current' || marker === 'default');
    const name = cliState ? match[2].replace(/\s+\([^)]+\)\s*$/, '').trim() : match[2];
    return [{ id: match[1], name, isDefault: markers.includes('default') }];
  });
  return {
    models,
    defaultModel: models.find((model) => model.isDefault)?.id || null,
  };
}

async function runClaudeDiscovery(provider: AgentProviderConfig): Promise<string> {
  const { stdout } = await executeFile(provider.command, ['-p', '--output-format=json', '/model'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: agentProviderEnvironment(provider),
  });
  return stdout;
}

async function runCursorDiscovery(command: string): Promise<string> {
  const { stdout } = await executeFile(command, ['--list-models'], {
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb' },
  });
  return stdout;
}

async function discoverClaudeModels(
  provider: AgentProviderConfig,
  runner: (provider: AgentProviderConfig) => Promise<string>,
  cache: boolean,
): Promise<AgentModelDiscovery> {
  const cacheKey = JSON.stringify([provider.command, provider.args, provider.env]);
  const cached = cache ? claudeCache.get(cacheKey) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.discovery;
  try {
    const discovery = parseClaudeModels(await runner(provider));
    if (cache) claudeCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, discovery });
    return discovery;
  } catch (error) {
    const discovery = {
      models: [],
      defaultModel: null,
      error: error instanceof Error ? error.message : String(error),
    };
    if (cache) claudeCache.set(cacheKey, { expiresAt: Date.now() + 60_000, discovery });
    return discovery;
  }
}

async function discoverCursorModels(
  provider: AgentProviderConfig,
  runner: (command: string) => Promise<string>,
  cache: boolean,
): Promise<AgentModelDiscovery> {
  const cached = cache ? cursorCache.get(provider.command) : undefined;
  if (cached && cached.expiresAt > Date.now()) return cached.discovery;
  try {
    const discovery = parseCursorModels(await runner(provider.command));
    if (cache) cursorCache.set(provider.command, { expiresAt: Date.now() + 5 * 60_000, discovery });
    return discovery;
  } catch (error) {
    const discovery = {
      models: [],
      defaultModel: null,
      error: error instanceof Error ? error.message : String(error),
    };
    if (cache) cursorCache.set(provider.command, { expiresAt: Date.now() + 60_000, discovery });
    return discovery;
  }
}

export async function discoverAgentModels(
  provider: AgentProviderConfig,
  options: {
    codexHome?: string;
    runClaude?: (provider: AgentProviderConfig) => Promise<string>;
    runCursor?: (command: string) => Promise<string>;
  } = {},
): Promise<AgentModelDiscovery> {
  const family = agentProviderFamily(provider.command);
  if (family === 'claude') {
    return discoverClaudeModels(provider, options.runClaude || runClaudeDiscovery, !options.runClaude);
  }
  if (family === 'cursor') {
    return discoverCursorModels(provider, options.runCursor || runCursorDiscovery, !options.runCursor);
  }
  if (family !== 'codex') return { models: [], defaultModel: null };
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const defaultModel = codexDefaultModel(provider, codexHome);
  const models = codexModels(codexHome);
  if (defaultModel && !models.some((model) => model.id === defaultModel)) {
    models.unshift({ id: defaultModel, name: defaultModel });
  }
  return {
    defaultModel,
    models: models.map((model) => ({ ...model, isDefault: model.id === defaultModel })),
  };
}
