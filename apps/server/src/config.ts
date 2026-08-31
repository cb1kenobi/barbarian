import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parse } from 'yaml';
import { z } from 'zod';
import type { BarbarianConfig } from './types.js';

const repositorySchema = z.object({
  name: z.string().regex(/^[^/]+\/[^/]+$/),
  priority: z.number().int().default(0),
  watchIssues: z.boolean().default(true),
  watchPullRequests: z.boolean().default(true),
  reviewSkill: z.string().default('cb1-code-review'),
  labels: z.record(z.string(), z.number().int()).default({}),
});

const configSchema = z.object({
  version: z.literal(1),
  profile: z.object({
    name: z.string().default('Developer'),
    timezone: z.string().default('UTC'),
    githubLogin: z.string().default(''),
  }),
  monitor: z.object({
    intervalMinutes: z.number().int().min(20).default(20),
    runOnStartup: z.boolean().default(true),
    includeDraftPullRequests: z.boolean().default(false),
  }),
  repositories: z.array(repositorySchema).default([]),
  review: z.object({
    requestedReviewer: z.string().default(''),
    fallbackTeams: z.array(z.string()).default([]),
    workspaceRoot: z.string().default('.barbarian/workspaces'),
    autoCleanup: z.boolean().default(true),
  }),
  linear: z.object({ enabled: z.boolean().default(false), command: z.array(z.string()).default([]) }),
  agents: z.object({
    default: z.string().default('codex'),
    providers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()).default([]) })).default({}),
  }),
  statusUpdate: z.object({
    enabled: z.boolean().default(true),
    workdays: z.array(z.string()).default(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
    daysOff: z.array(z.string()).default([]),
  }),
});

export const projectRoot = path.resolve(process.env.BARBARIAN_ROOT || process.cwd());
export const configPath = path.join(projectRoot, 'config/barbarian.yaml');
export const envPath = path.join(projectRoot, '.env');

export async function ensureLocalFiles(): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.join(projectRoot, 'data'), { recursive: true });
  if (!existsSync(configPath)) {
    await copyFile(path.join(projectRoot, 'config/barbarian.example.yaml'), configPath);
  }
  if (!existsSync(envPath)) {
    await copyFile(path.join(projectRoot, '.env.example'), envPath);
  }
  await Promise.all([chmod(configPath, 0o600), chmod(envPath, 0o600)]);
}

export async function loadConfig(): Promise<BarbarianConfig> {
  await ensureLocalFiles();
  const source = await readFile(configPath, 'utf8');
  return configSchema.parse(parse(source)) as BarbarianConfig;
}

export async function saveConfig(config: BarbarianConfig): Promise<void> {
  const { stringify } = await import('yaml');
  await writeFile(configPath, stringify(config), { mode: 0o600 });
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
