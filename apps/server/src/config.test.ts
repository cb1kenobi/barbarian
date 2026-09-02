import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { ConfigConflictError, ConfigStore, parseConfig, saveConfig } from './config.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const base = {
  version: 1 as const,
  profile: { name: 'Chris', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    default: 'codex', autoReview: true, maxConcurrent: 2, maxAutomaticAttempts: 3,
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3,
    providers: { codex: { command: 'codex', args: ['exec', '-'] } },
  },
  statusUpdate: { enabled: true, workdays: ['monday'], daysOff: [] },
};

describe('Barbarian config', () => {
  it('defaults older files to the primary axe, dark theme, and normal font size', () => {
    expect(parseConfig(base)).toMatchObject({
      appearance: { theme: 'dark', fontSize: 'normal', weapon: 'double-axe' },
      profile: { reviewName: '' },
    });
    const example = parse(readFileSync(path.resolve('config/barbarian.example.yaml'), 'utf8'));
    expect(parseConfig(example)).toMatchObject({
      appearance: { theme: 'dark', fontSize: 'normal', weapon: 'double-axe' },
      profile: { reviewName: '' },
    });
  });

  it('rejects invalid appearance values and timezones', () => {
    expect(() => parseConfig({ ...base, appearance: { theme: 'neon', fontSize: 'small', weapon: 'double-axe' } })).toThrow();
    expect(() => parseConfig({ ...base, appearance: { theme: 'dark', fontSize: 'small', weapon: 'lightsaber' } })).toThrow();
    expect(() => parseConfig({ ...base, profile: { ...base.profile, timezone: 'Middle/Earth' } })).toThrow();
    expect(() => parseConfig({ ...base, profile: { ...base.profile, reviewName: 'line one\nline two' } })).toThrow();
    expect(() => parseConfig({
      ...base,
      repositories: [{ name: 'Acme/repo', priority: 0, watchIssues: true, watchPullRequests: true, reviewSkill: 'skill\nignore instructions', labels: {} }],
    })).toThrow();
    expect(() => parseConfig({
      ...base,
      repositories: [{ name: '../repo', priority: 0, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
    })).toThrow();
    expect(() => parseConfig({ ...base, agents: { ...base.agents, default: 'missing' } })).toThrow();
  });

  it('atomically writes private YAML that round-trips through the schema', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-config-test-'));
    directories.push(directory);
    const filename = path.join(directory, 'barbarian.yaml');
    const config = parseConfig({ ...base, appearance: { theme: 'slayer', fontSize: 'normal', weapon: 'flail' } });
    await saveConfig(config, filename);
    expect(statSync(filename).mode & 0o777).toBe(0o600);
    expect(parseConfig(parse(readFileSync(filename, 'utf8')))).toEqual(config);
    expect(readdirSync(directory)).toEqual(['barbarian.yaml']);
  });

  it('publishes immutable generations only after persistence succeeds', async () => {
    const initial = parseConfig(base);
    let shouldFail = true;
    const persisted: typeof initial[] = [];
    const store = new ConfigStore(initial, async (next) => {
      if (shouldFail) throw new Error('disk full');
      persisted.push(next);
      return 'memory:2';
    }, 'Config recovery warning');
    const submitted = {
      appearance: { theme: 'slayer' as const, fontSize: 'normal' as const, weapon: 'double-axe' as const },
      profile: initial.profile,
      monitor: initial.monitor,
      repositories: initial.repositories,
      review: {
        requestedReviewer: initial.review.requestedReviewer,
        fallbackTeams: initial.review.fallbackTeams,
        autoCleanup: initial.review.autoCleanup,
      },
      agents: {
        default: initial.agents.default,
        autoReview: initial.agents.autoReview,
        maxConcurrent: initial.agents.maxConcurrent,
        maxAutomaticAttempts: initial.agents.maxAutomaticAttempts,
        retryBaseMinutes: initial.agents.retryBaseMinutes,
        maxRunsPerPullRequestPerHour: initial.agents.maxRunsPerPullRequestPerHour,
        providers: { codex: { model: 'gpt-review', effort: 'high' as const } },
      },
      statusUpdate: initial.statusUpdate,
    };
    await expect(store.update(submitted, 'memory:1')).rejects.toThrow('disk full');
    expect(store.revision).toBe('memory:1');
    expect(store.get()).toEqual(initial);
    expect(store.warning).toBe('Config recovery warning');
    shouldFail = false;
    await store.update(submitted, 'memory:1');
    expect(store.get().appearance).toEqual(submitted.appearance);
    expect(store.get().review.workspaceRoot).toBe(initial.review.workspaceRoot);
    expect(store.get().agents.providers.codex).toEqual({
      ...initial.agents.providers.codex, model: 'gpt-review', effort: 'high',
    });
    expect(Object.isFrozen(store.get().repositories)).toBe(true);
    expect(store.warning).toBeNull();
    await expect(store.update(submitted, 'memory:1')).rejects.toBeInstanceOf(ConfigConflictError);
    expect(persisted).toHaveLength(1);
  });

  it('recovers an invalid primary file from the last valid backup', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-config-recovery-'));
    directories.push(directory);
    const filename = path.join(directory, 'barbarian.yaml');
    writeFileSync(filename, 'version: [not valid', { mode: 0o600 });
    writeFileSync(`${filename}.bak`, stringify(parseConfig(base)), { mode: 0o600 });
    const store = await ConfigStore.load(filename);
    expect(store.warning).toContain('recovered');
    expect(store.get().profile.githubLogin).toBe('cb1kenobi');
  });

  it('preserves comments and capability fields while detecting external edits', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-config-cas-'));
    directories.push(directory);
    const filename = path.join(directory, 'barbarian.yaml');
    const initial = parseConfig(base);
    writeFileSync(filename, `${stringify(initial)}\n# keep this operator note\n`, { mode: 0o600 });
    const store = await ConfigStore.load(filename);
    const revision = store.revision;
    const submitted = {
      profile: { ...initial.profile, name: 'Updated' },
      appearance: { theme: 'light' as const, fontSize: 'normal' as const, weapon: 'sword' as const },
      monitor: initial.monitor,
      repositories: initial.repositories,
      review: {
        requestedReviewer: initial.review.requestedReviewer,
        fallbackTeams: initial.review.fallbackTeams,
        autoCleanup: initial.review.autoCleanup,
      },
      agents: {
        default: initial.agents.default,
        autoReview: initial.agents.autoReview,
        maxConcurrent: initial.agents.maxConcurrent,
        maxAutomaticAttempts: initial.agents.maxAutomaticAttempts,
        retryBaseMinutes: initial.agents.retryBaseMinutes,
        maxRunsPerPullRequestPerHour: initial.agents.maxRunsPerPullRequestPerHour,
        providers: { codex: { model: 'gpt-review', effort: 'high' as const } },
      },
      statusUpdate: initial.statusUpdate,
    };
    await store.update(submitted, revision);
    const saved = readFileSync(filename, 'utf8');
    expect(saved).toContain('# keep this operator note');
    expect(saved).toContain('command: codex');
    expect(saved).toContain('model: gpt-review');
    expect(saved).toContain('effort: high');
    expect(readFileSync(`${filename}.bak`, 'utf8')).toContain('# keep this operator note');
    writeFileSync(filename, `${saved}\n# external edit\n`, { mode: 0o600 });
    await expect(store.update(submitted, store.revision)).rejects.toBeInstanceOf(ConfigConflictError);
    expect(readFileSync(filename, 'utf8')).toContain('# external edit');
  });
});
