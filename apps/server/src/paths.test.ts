import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyState, runtimePaths } from './paths.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('runtime paths', () => {
  it('separates packaged resources, persistent state, and cache files', () => {
    const paths = runtimePaths({
      BARBARIAN_RESOURCE_ROOT: '/Applications/Barbarian.app/Contents/Resources/app',
      BARBARIAN_HOME: '/Users/test/Library/Application Support/Barbarian',
      BARBARIAN_CACHE_HOME: '/Users/test/Library/Caches/Barbarian',
    }, '/ignored');
    expect(paths.webRoot).toBe('/Applications/Barbarian.app/Contents/Resources/app/dist/web');
    expect(paths.configPath).toBe('/Users/test/Library/Application Support/Barbarian/config/barbarian.yaml');
    expect(paths.databasePath).toBe('/Users/test/Library/Application Support/Barbarian/data/barbarian.db');
    expect(paths.cacheRoot).toBe('/Users/test/Library/Caches/Barbarian');
  });

  it('copies legacy state without deleting or overwriting either side', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-paths-test-'));
    directories.push(directory);
    const resourceRoot = path.join(directory, 'source');
    const userDataRoot = path.join(directory, 'destination');
    await mkdir(path.join(resourceRoot, 'config'), { recursive: true });
    await mkdir(path.join(resourceRoot, 'data'), { recursive: true });
    writeFileSync(path.join(resourceRoot, 'config/barbarian.yaml'), 'version: 1\n');
    writeFileSync(path.join(resourceRoot, 'data/barbarian.db'), 'database');
    writeFileSync(path.join(resourceRoot, 'data/barbarian.lock'), 'stale lock');
    writeFileSync(path.join(resourceRoot, '.env'), 'TOKEN=secret\n');
    const paths = runtimePaths({
      BARBARIAN_RESOURCE_ROOT: resourceRoot,
      BARBARIAN_HOME: userDataRoot,
      BARBARIAN_CACHE_HOME: path.join(directory, 'cache'),
    });

    await expect(migrateLegacyState(paths)).resolves.toBe(true);
    expect(readFileSync(paths.configPath, 'utf8')).toBe('version: 1\n');
    expect(readFileSync(paths.databasePath, 'utf8')).toBe('database');
    expect(readFileSync(paths.envPath, 'utf8')).toBe('TOKEN=secret\n');
    expect(() => readFileSync(paths.lockPath)).toThrow();
    expect(readFileSync(path.join(resourceRoot, 'data/barbarian.db'), 'utf8')).toBe('database');

    writeFileSync(paths.configPath, 'destination wins\n');
    await expect(migrateLegacyState(paths)).resolves.toBe(false);
    expect(readFileSync(paths.configPath, 'utf8')).toBe('destination wins\n');
  });

  it('refuses to copy a database owned by a running legacy server', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-paths-test-'));
    directories.push(directory);
    const resourceRoot = path.join(directory, 'source');
    const paths = runtimePaths({
      BARBARIAN_RESOURCE_ROOT: resourceRoot,
      BARBARIAN_HOME: path.join(directory, 'destination'),
      BARBARIAN_CACHE_HOME: path.join(directory, 'cache'),
    });
    await mkdir(path.join(resourceRoot, 'data'), { recursive: true });
    writeFileSync(path.join(resourceRoot, 'data/barbarian.db'), 'database');
    writeFileSync(path.join(resourceRoot, 'data/barbarian.lock'), JSON.stringify({ pid: process.pid }));

    await expect(migrateLegacyState(paths)).rejects.toThrow(/Stop the existing Barbarian server/);
    expect(() => readFileSync(paths.databasePath)).toThrow();
  });

  it('does not mix legacy database sidecars into existing destination state', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-paths-test-'));
    directories.push(directory);
    const resourceRoot = path.join(directory, 'source');
    const paths = runtimePaths({
      BARBARIAN_RESOURCE_ROOT: resourceRoot,
      BARBARIAN_HOME: path.join(directory, 'destination'),
      BARBARIAN_CACHE_HOME: path.join(directory, 'cache'),
    });
    await mkdir(path.join(resourceRoot, 'config'), { recursive: true });
    await mkdir(path.join(resourceRoot, 'data'), { recursive: true });
    await mkdir(paths.dataDirectory, { recursive: true });
    writeFileSync(path.join(resourceRoot, 'config/barbarian.yaml'), 'version: 1\n');
    writeFileSync(path.join(resourceRoot, 'data/barbarian.db'), 'legacy');
    writeFileSync(path.join(resourceRoot, 'data/barbarian.db-wal'), 'legacy wal');
    writeFileSync(paths.databasePath, 'current');

    await expect(migrateLegacyState(paths)).resolves.toBe(true);
    expect(readFileSync(paths.databasePath, 'utf8')).toBe('current');
    expect(() => readFileSync(`${paths.databasePath}-wal`)).toThrow();
  });
});
