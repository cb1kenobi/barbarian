import { copyFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RuntimePaths {
  resourceRoot: string;
  userDataRoot: string;
  cacheRoot: string;
  configPath: string;
  envPath: string;
  dataDirectory: string;
  databasePath: string;
  lockPath: string;
  webRoot: string;
}

function defaultUserDataRoot(environment: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Barbarian');
  if (process.platform === 'win32') {
    return path.join(environment.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'Barbarian');
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'barbarian');
}

function defaultCacheRoot(environment: NodeJS.ProcessEnv): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Caches/Barbarian');
  if (process.platform === 'win32') {
    return path.join(environment.LOCALAPPDATA || path.join(os.homedir(), 'AppData/Local'), 'Barbarian/Cache');
  }
  return path.join(environment.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'barbarian');
}

export function runtimePaths(environment: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): RuntimePaths {
  const resourceRoot = path.resolve(environment.BARBARIAN_RESOURCE_ROOT || environment.BARBARIAN_ROOT || cwd);
  const userDataRoot = path.resolve(environment.BARBARIAN_HOME || defaultUserDataRoot(environment));
  const cacheRoot = path.resolve(environment.BARBARIAN_CACHE_HOME || defaultCacheRoot(environment));
  const dataDirectory = path.join(userDataRoot, 'data');
  return {
    resourceRoot,
    userDataRoot,
    cacheRoot,
    configPath: path.join(userDataRoot, 'config/barbarian.yaml'),
    envPath: path.join(userDataRoot, '.env'),
    dataDirectory,
    databasePath: path.join(dataDirectory, 'barbarian.db'),
    lockPath: path.join(dataDirectory, 'barbarian.lock'),
    webRoot: path.join(resourceRoot, 'dist/web'),
  };
}

export const paths = runtimePaths();

async function copyAtomically(source: string, destination: string): Promise<void> {
  if (existsSync(destination) || !existsSync(source)) return;
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.migration`;
  await copyFile(source, temporary);
  await rename(temporary, destination);
}

async function copyDirectoryFiles(sourceDirectory: string, destinationDirectory: string): Promise<void> {
  if (!existsSync(sourceDirectory)) return;
  await mkdir(destinationDirectory, { recursive: true });
  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === 'barbarian.lock') continue;
    await copyAtomically(path.join(sourceDirectory, entry.name), path.join(destinationDirectory, entry.name));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function assertLegacyDatabaseIsIdle(runtime: RuntimePaths): Promise<void> {
  const legacyLock = path.join(runtime.resourceRoot, 'data/barbarian.lock');
  if (!existsSync(legacyLock)) return;
  const owner: { pid?: number } = await readFile(legacyLock, 'utf8')
    .then((value) => JSON.parse(value) as { pid?: number })
    .catch(() => ({}));
  if (owner.pid && processExists(owner.pid)) {
    throw new Error(`Stop the existing Barbarian server (process ${owner.pid}) before migrating its SQLite database`);
  }
}

export async function migrateLegacyState(runtime = paths): Promise<boolean> {
  if (path.resolve(runtime.resourceRoot) === path.resolve(runtime.userDataRoot)) return false;
  const legacyConfig = path.join(runtime.resourceRoot, 'config/barbarian.yaml');
  const legacyDatabase = path.join(runtime.resourceRoot, 'data/barbarian.db');
  const needsConfig = existsSync(legacyConfig) && !existsSync(runtime.configPath);
  const needsDatabase = existsSync(legacyDatabase) && !existsSync(runtime.databasePath);
  if (!needsConfig && !needsDatabase) return false;

  if (needsDatabase) await assertLegacyDatabaseIsIdle(runtime);

  await copyDirectoryFiles(path.join(runtime.resourceRoot, 'config'), path.join(runtime.userDataRoot, 'config'));
  await copyDirectoryFiles(path.join(runtime.resourceRoot, 'data'), runtime.dataDirectory);
  await copyAtomically(path.join(runtime.resourceRoot, '.env'), runtime.envPath);
  return true;
}

export async function ensureRuntimeDirectories(runtime = paths): Promise<void> {
  await Promise.all([
    mkdir(path.dirname(runtime.configPath), { recursive: true }),
    mkdir(runtime.dataDirectory, { recursive: true }),
    mkdir(runtime.cacheRoot, { recursive: true }),
  ]);
}
