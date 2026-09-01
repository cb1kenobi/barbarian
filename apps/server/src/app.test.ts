import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { BarbarianConfig } from './types.js';
import { BarbarianDatabase } from './database.js';
import { ConfigStore } from './config.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
  version: 1,
  profile: { name: 'Chris', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  appearance: { theme: 'dark', fontSize: 'small' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [{ name: 'Acme/storage', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    default: 'codex', autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: {},
  },
  statusUpdate: { enabled: false, workdays: [], daysOff: [] },
};

describe('dashboard reviews', () => {
  it('returns every open review without a display limit', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-app-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const insert = database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        first_seen_at, updated_at, last_seen_at
      ) VALUES (?, 'Acme/storage', ?, ?, ?, 'author', ?, 'feature', 'main', ?, ?, ?)
    `);
    for (let number = 1; number <= 500; number += 1) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString();
      insert.run(
        `github:Acme/storage#${number}`, number, `Review ${number}`, `https://example.test/${number}`,
        `head-${number}`, timestamp, timestamp, timestamp,
      );
    }
    database.connection.prepare(`
      UPDATE review_queue SET remote_updated_at='2026-01-02T03:04:00Z' WHERE number=1
    `).run();
    database.connection.prepare(`
      INSERT INTO agent_runs(review_id,provider,task,status,started_at,finished_at)
      VALUES ('github:Acme/storage#1','codex','code_review:new_pr','complete',
        '2026-01-02T04:00:00Z','2026-01-02T04:05:00Z')
    `).run();
    const finding = database.connection.prepare(`
      INSERT INTO review_findings(
        id,review_id,remote_id,author,body,summary,url,resolved,outdated,created_at,updated_at
      ) VALUES (?, 'github:Acme/storage#1', ?, 'agent', ?, '', 'https://example.test/finding', 0, 0,
        '2026-01-02T04:05:00Z','2026-01-02T04:05:00Z')
    `);
    finding.run('finding-high', 1, '**High: blocking bug**');
    finding.run('finding-low', 2, 'Nit: simplify this');

    const app = await createApp(database, new ConfigStore(config));
    try {
      const response = await app.inject({ method: 'GET', url: '/api/dashboard' });
      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        reviews: Array<Record<string, unknown>>;
        statusDraft: { lines: string[] };
      };
      const reviews = payload.reviews;
      expect(reviews).toHaveLength(500);
      expect(reviews.find((review) => review.number === 1)).toMatchObject({
        remote_updated_at: '2026-01-02T03:04:00Z',
        last_agent_review_at: '2026-01-02T04:05:00Z',
        issue_counts: { high: 1, medium: 0, low: 1 },
      });
      expect(payload.statusDraft.lines).toHaveLength(3);
      expect(payload.statusDraft.lines.every((line) => line.startsWith('* storage: Reviewing #'))).toBe(true);
      expect(payload.statusDraft.lines.every((line) => !line.includes(' - '))).toBe(true);
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('settings API', () => {
  it('validates, persists, and activates complete config updates without exposing env settings', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-settings-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const current = structuredClone(config);
    current.agents.providers = { codex: { command: '/secret/codex', args: ['--api-key', 'sk-not-for-api'] } };
    const persisted: BarbarianConfig[] = [];
    const store = new ConfigStore(current, async (value) => { persisted.push(structuredClone(value)); return 'memory:2'; });
    const app = await createApp(database, store);
    try {
      const before = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({
        config: { appearance: { theme: 'dark', fontSize: 'small' } },
        revision: 'memory:1',
        configFile: 'config/barbarian.yaml',
      });
      expect(before.body).not.toContain('envFile');
      expect(before.body).not.toContain('/secret/codex');
      expect(before.body).not.toContain('sk-not-for-api');

      const editable = (before.json() as { config: Record<string, unknown> }).config;
      const next = {
        ...editable,
        profile: { ...current.profile, name: 'Barbarian' },
        appearance: { theme: 'slayer', fontSize: 'normal' },
        repositories: [...current.repositories, {
          name: 'Acme/ui', priority: 5, watchIssues: false, watchPullRequests: true,
          reviewSkill: 'cb1-code-review', labels: { accessibility: 25 },
        }],
      };
      const protectedFields = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { revision: 'memory:1', config: { ...next, linear: { enabled: true, command: ['/bin/sh'] } } },
      });
      expect(protectedFields.statusCode).toBe(400);
      expect(persisted).toHaveLength(0);

      const extensionWrite = await app.inject({
        method: 'PUT', url: '/api/settings', headers: { origin: 'chrome-extension://untrusted' },
        payload: { revision: 'memory:1', config: next },
      });
      expect(extensionWrite.statusCode).toBe(403);
      expect(persisted).toHaveLength(0);

      const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { revision: 'memory:1', config: next } });
      expect(saved.statusCode).toBe(200);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject(next);
      expect(persisted[0]!.agents.providers).toEqual(current.agents.providers);
      expect(persisted[0]!.review.workspaceRoot).toBe(current.review.workspaceRoot);
      expect(store.get()).toMatchObject({ profile: { name: 'Barbarian' }, appearance: next.appearance });
      expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(200);

      const invalid = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { revision: 'memory:2', config: { ...next, appearance: { theme: 'neon', fontSize: 'normal' } } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(persisted).toHaveLength(1);
      expect(store.get().appearance.theme).toBe('slayer');

      const stale = await app.inject({ method: 'PUT', url: '/api/settings', payload: { revision: 'memory:1', config: next } });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
      database.close();
    }
  });
});
