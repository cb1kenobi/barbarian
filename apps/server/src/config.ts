import { chmod, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { parse, parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { BarbarianConfig } from './types.js';

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const repositorySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/).refine(
    (name) => name.split('/').every((segment) => segment !== '.' && segment !== '..'),
    'Repository owner and name cannot be path segments',
  ),
  priority: z.number().int().default(0),
  watchIssues: z.boolean().default(true),
  watchPullRequests: z.boolean().default(true),
  reviewSkill: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).default('cb1-code-review'),
  labels: z.record(z.string(), z.number().int()).default({}),
}).strict();

const agentEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const agentSelectionSchema = z.object({
  provider: z.string().min(1).max(100),
  model: z.string().max(200).default(''),
  effort: z.union([agentEffortSchema, z.literal('')]).default(''),
}).strict();

const agentsSchema = z.object({
  codeReview: agentSelectionSchema,
  chat: agentSelectionSchema,
  autoReview: z.boolean().default(false),
  maxConcurrent: z.number().int().min(1).max(8).default(2),
  maxAutomaticAttempts: z.number().int().min(1).max(10).default(3),
  retryBaseMinutes: z.number().int().min(1).max(120).default(5),
  maxRunsPerPullRequestPerHour: z.number().int().min(1).max(20).default(3),
  providers: z.record(z.string(), z.object({
    command: z.string(), args: z.array(z.string()).default([]), model: z.string().optional(),
    effort: agentEffortSchema.optional(),
  })).default({}),
});

export const configSchema = z.object({
  version: z.literal(1),
  profile: z.object({
    name: z.string().default('Developer'),
    reviewName: z.string().trim().max(80).regex(/^[^\r\n]*$/, 'Review name must be a single line').default(''),
    timezone: z.string().refine(validTimezone, 'Invalid IANA timezone').default('UTC'),
    githubLogin: z.string().default(''),
  }),
  appearance: z.object({
    theme: z.enum(['light', 'dark', 'slayer']).default('dark'),
    fontSize: z.enum(['small', 'normal']).default('normal'),
    weapon: z.enum(['double-axe', 'sword', 'crossed-swords', 'single-axe', 'mace', 'flail', 'nunchucks', 'hammer']).default('double-axe'),
  }).default({ theme: 'dark', fontSize: 'normal', weapon: 'double-axe' }),
  monitor: z.object({
    intervalMinutes: z.number().int().min(20).default(20),
    runOnStartup: z.boolean().default(true),
    includeDraftPullRequests: z.boolean().default(false),
  }),
  repositories: z.array(repositorySchema).refine(
    (repositories) => new Set(repositories.map((repository) => repository.name.toLowerCase())).size === repositories.length,
    'Repository names must be unique',
  ).default([]),
  review: z.object({
    requestedReviewer: z.string().default(''),
    fallbackTeams: z.array(z.string()).default([]),
    workspaceRoot: z.string().default('.barbarian/workspaces'),
    autoCleanup: z.boolean().default(true),
  }),
  linear: z.object({ enabled: z.boolean().default(false), command: z.array(z.string()).default([]) }),
  agents: agentsSchema.superRefine((agents, context) => {
    for (const [field, selection] of [['codeReview', agents.codeReview], ['chat', agents.chat]] as const) {
      if (Object.keys(agents.providers).length > 0 && !agents.providers[selection.provider]) {
        context.addIssue({ code: 'custom', path: [field, 'provider'], message: 'Agent must name a configured provider' });
      }
    }
  }),
  statusUpdate: z.object({
    enabled: z.boolean().default(true),
    workdays: z.array(z.string()).default(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
    daysOff: z.array(z.string()).default([]),
  }),
});

export const writableConfigSchema = z.object({
  profile: configSchema.shape.profile.strict(),
  appearance: configSchema.shape.appearance.unwrap().strict(),
  monitor: configSchema.shape.monitor.strict(),
  repositories: configSchema.shape.repositories,
  review: configSchema.shape.review.pick({ requestedReviewer: true, fallbackTeams: true, autoCleanup: true }).strict(),
  agents: agentsSchema.pick({
    codeReview: true,
    chat: true,
    autoReview: true,
    maxConcurrent: true,
    maxAutomaticAttempts: true,
    retryBaseMinutes: true,
    maxRunsPerPullRequestPerHour: true,
  }).strict(),
  statusUpdate: configSchema.shape.statusUpdate.strict(),
}).strict();

export type WritableConfig = z.infer<typeof writableConfigSchema>;

export const projectRoot = path.resolve(process.env.BARBARIAN_ROOT || process.cwd());
export const configPath = path.join(projectRoot, 'config/barbarian.yaml');
export const envPath = path.join(projectRoot, '.env');

export async function ensureLocalFiles(): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.join(projectRoot, 'data'), { recursive: true });
  if (!existsSync(configPath)) {
    const backup = `${configPath}.bak`;
    await copyFile(existsSync(backup) ? backup : path.join(projectRoot, 'config/barbarian.example.yaml'), configPath);
  }
  if (!existsSync(envPath)) {
    await copyFile(path.join(projectRoot, '.env.example'), envPath);
  }
  await Promise.all([chmod(configPath, 0o600), chmod(envPath, 0o600)]);
}

export async function loadConfig(): Promise<BarbarianConfig> {
  return (await ConfigStore.load()).get();
}

export function parseConfig(value: unknown): BarbarianConfig {
  if (!value || typeof value !== 'object') return configSchema.parse(value) as BarbarianConfig;
  const source = value as Record<string, unknown>;
  const rawAgents = source.agents && typeof source.agents === 'object'
    ? source.agents as Record<string, unknown>
    : {};
  const legacyProviderName = typeof rawAgents.default === 'string' ? rawAgents.default : 'codex';
  const rawProviders = rawAgents.providers && typeof rawAgents.providers === 'object'
    ? rawAgents.providers as Record<string, unknown>
    : {};
  const legacyProvider = rawProviders[legacyProviderName] && typeof rawProviders[legacyProviderName] === 'object'
    ? rawProviders[legacyProviderName] as Record<string, unknown>
    : {};
  const legacySelection = {
    provider: legacyProviderName,
    model: typeof legacyProvider.model === 'string' ? legacyProvider.model : '',
    effort: typeof legacyProvider.effort === 'string' ? legacyProvider.effort : '',
  };
  return configSchema.parse({
    ...source,
    agents: {
      ...rawAgents,
      codeReview: rawAgents.codeReview || legacySelection,
      chat: rawAgents.chat || legacySelection,
    },
  }) as BarbarianConfig;
}

function contentRevision(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

async function persistYaml(source: string, filename: string, expectedRevision?: string, preserveBackup = false): Promise<string> {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (expectedRevision !== undefined) {
      const currentSource = await readFile(filename, 'utf8').catch(() => '');
      if (contentRevision(currentSource) !== expectedRevision) throw new ConfigConflictError('Settings changed on disk. Reload and try again.');
    }
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(source, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (!preserveBackup && existsSync(filename)) {
      await copyFile(filename, `${filename}.bak`);
      await chmod(`${filename}.bak`, 0o600);
    }
    await rename(temporary, filename);
    await chmod(filename, 0o600);
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return contentRevision(source);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function saveConfig(config: BarbarianConfig, filename = configPath): Promise<void> {
  await persistYaml(stringify(config), filename);
}

function safeUpdate(current: BarbarianConfig, submitted: WritableConfig): BarbarianConfig {
  return parseConfig({
    ...current,
    profile: submitted.profile,
    appearance: submitted.appearance,
    monitor: submitted.monitor,
    repositories: submitted.repositories,
    review: {
      ...current.review,
      requestedReviewer: submitted.review.requestedReviewer,
      fallbackTeams: submitted.review.fallbackTeams,
      autoCleanup: submitted.review.autoCleanup,
    },
    agents: {
      ...current.agents,
      codeReview: submitted.agents.codeReview,
      chat: submitted.agents.chat,
      autoReview: submitted.agents.autoReview,
      maxConcurrent: submitted.agents.maxConcurrent,
      maxAutomaticAttempts: submitted.agents.maxAutomaticAttempts,
      retryBaseMinutes: submitted.agents.retryBaseMinutes,
      maxRunsPerPullRequestPerHour: submitted.agents.maxRunsPerPullRequestPerHour,
      providers: current.agents.providers,
    },
    statusUpdate: submitted.statusUpdate,
  });
}

const writablePaths: Array<{ path: Array<string>; value: (config: BarbarianConfig) => unknown }> = [
  { path: ['profile'], value: (config) => config.profile },
  { path: ['appearance'], value: (config) => config.appearance },
  { path: ['monitor'], value: (config) => config.monitor },
  { path: ['repositories'], value: (config) => config.repositories },
  { path: ['review', 'requestedReviewer'], value: (config) => config.review.requestedReviewer },
  { path: ['review', 'fallbackTeams'], value: (config) => config.review.fallbackTeams },
  { path: ['review', 'autoCleanup'], value: (config) => config.review.autoCleanup },
  { path: ['agents', 'codeReview'], value: (config) => config.agents.codeReview },
  { path: ['agents', 'chat'], value: (config) => config.agents.chat },
  { path: ['agents', 'autoReview'], value: (config) => config.agents.autoReview },
  { path: ['agents', 'maxConcurrent'], value: (config) => config.agents.maxConcurrent },
  { path: ['agents', 'maxAutomaticAttempts'], value: (config) => config.agents.maxAutomaticAttempts },
  { path: ['agents', 'retryBaseMinutes'], value: (config) => config.agents.retryBaseMinutes },
  { path: ['agents', 'maxRunsPerPullRequestPerHour'], value: (config) => config.agents.maxRunsPerPullRequestPerHour },
  { path: ['statusUpdate'], value: (config) => config.statusUpdate },
];

export async function saveConfigUpdate(
  config: BarbarianConfig,
  filename = configPath,
  expectedRevision?: string,
  documentSource?: string,
): Promise<string> {
  const document = parseDocument(documentSource ?? await readFile(filename, 'utf8'));
  if (document.errors.length) throw document.errors[0];
  for (const entry of writablePaths) document.setIn(entry.path, entry.value(config));
  document.deleteIn(['agents', 'default']);
  for (const [name, provider] of Object.entries(config.agents.providers)) {
    const modelPath = ['agents', 'providers', name, 'model'];
    const effortPath = ['agents', 'providers', name, 'effort'];
    document.deleteIn(modelPath);
    document.deleteIn(effortPath);
  }
  return persistYaml(document.toString(), filename, expectedRevision, documentSource !== undefined);
}

function freezeConfig(config: BarbarianConfig): BarbarianConfig {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(config);
  return config;
}

export class ConfigConflictError extends Error {}

export class ConfigStore {
  private current: BarbarianConfig;
  private revisionValue: string;
  private tail = Promise.resolve();

  constructor(
    initial: BarbarianConfig,
    private readonly persist: (config: BarbarianConfig, expectedRevision: string) => Promise<string> = (config, expected) => saveConfigUpdate(config, configPath, expected),
    warning: string | null = null,
    revision = 'memory:1',
  ) {
    this.current = freezeConfig(structuredClone(initial));
    this.revisionValue = revision;
    this.warning = warning;
  }

  warning: string | null;

  static async load(filename = configPath): Promise<ConfigStore> {
    if (filename === configPath) await ensureLocalFiles();
    let primarySource = '';
    try {
      primarySource = await readFile(filename, 'utf8');
      const config = parseConfig(parse(primarySource));
      return new ConfigStore(config, (next, expected) => saveConfigUpdate(next, filename, expected), null, contentRevision(primarySource));
    } catch (primaryError) {
      const backup = `${filename}.bak`;
      try {
        const backupSource = await readFile(backup, 'utf8');
        const config = parseConfig(parse(backupSource));
        const revision = contentRevision(primarySource || await readFile(filename, 'utf8').catch(() => ''));
        return new ConfigStore(
          config,
          (next, expected) => saveConfigUpdate(next, filename, expected, backupSource),
          `The primary config could not be loaded; Barbarian recovered ${path.basename(filename)} from its last valid backup.`,
          revision,
        );
      } catch {
        const config = parseConfig({
          version: 1,
          profile: {}, appearance: {}, monitor: {}, repositories: [], review: {}, linear: {}, agents: {}, statusUpdate: {},
        });
        const revision = contentRevision(primarySource || await readFile(filename, 'utf8').catch(() => ''));
        return new ConfigStore(
          config,
          (next, expected) => saveConfigUpdate(next, filename, expected, stringify(config)),
          `Neither ${path.basename(filename)} nor its backup could be loaded. Barbarian started with safe defaults so Settings can repair the file.`,
          revision,
        );
      }
    }
  }

  get(): BarbarianConfig {
    return this.current;
  }

  get revision(): string {
    return this.revisionValue;
  }

  update(submitted: unknown, expectedRevision: string): Promise<{ config: BarbarianConfig; revision: string }> {
    const run = async () => {
      if (expectedRevision !== this.revisionValue) throw new ConfigConflictError('Settings changed in another tab. Reload and try again.');
      const candidate = writableConfigSchema.parse(submitted);
      const next = freezeConfig(safeUpdate(this.current, candidate));
      const revision = await this.persist(next, expectedRevision);
      this.current = next;
      this.revisionValue = revision;
      this.warning = null;
      return { config: this.current, revision: this.revisionValue };
    };
    const operation = this.tail.then(run, run);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function resolveProjectPath(candidate: string): string {
  return path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate);
}

export function serverAddress(): { host: string; port: number } {
  return {
    host: process.env.BARBARIAN_HOST || '127.0.0.1',
    port: Number(process.env.BARBARIAN_PORT || 4142),
  };
}
