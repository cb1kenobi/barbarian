import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { applyDiscovery } from './sync.js';
import type { BarbarianConfig, DiscoveryResult } from './types.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
  version: 1,
  profile: { name: 'Chris', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [{ name: 'Acme/storage', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: ['Developers'], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: { default: 'codex', providers: {} },
  statusUpdate: { enabled: true, workdays: ['monday'], daysOff: [] },
};

function database(): BarbarianDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-test-'));
  directories.push(directory);
  return new BarbarianDatabase(path.join(directory, 'test.db'));
}

describe('applyDiscovery', () => {
  it('withholds issues that are already claimed, fixed, or duplicates', async () => {
    const db = database();
    const base = { provider: 'github' as const, repository: 'Acme/storage', body: '', updatedAt: '2026-08-31T10:00:00Z', labels: [], milestone: null, priority: 10, priorityReasons: [] };
    const result: DiscoveryResult = {
      discoveredAt: '2026-08-31T12:00:00Z', githubLogin: 'cb1kenobi', warnings: [], pullRequests: [],
      issues: [
        { ...base, number: 1, title: 'Actionable', url: 'https://example/1', duplicateOf: null, inProgressPr: null, fixedBy: null },
        { ...base, number: 2, title: 'Claimed', url: 'https://example/2', duplicateOf: null, inProgressPr: 'https://example/pr/2', fixedBy: null },
        { ...base, number: 3, title: 'Fixed', url: 'https://example/3', duplicateOf: null, inProgressPr: null, fixedBy: 'https://example/pr/3' },
        { ...base, number: 4, title: 'Duplicate', url: 'https://example/4', duplicateOf: '#1', inProgressPr: null, fixedBy: null },
      ],
    };
    await applyDiscovery(db, config, result);
    const rows = db.connection.prepare('SELECT number, status FROM work_items ORDER BY number').all();
    expect(rows).toEqual([
      { number: 1, status: 'queued' }, { number: 2, status: 'claimed_elsewhere' },
      { number: 3, status: 'already_fixed' }, { number: 4, status: 'duplicate' },
    ]);
    db.close();
  });

  it('tracks requested reviews and ignores unrelated pull requests', async () => {
    const db = database();
    const base = {
      provider: 'github' as const, repository: 'Acme/storage', body: '', author: 'author',
      headSha: 'abc', headRefName: 'feature', baseRefName: 'main', updatedAt: '2026-08-31T10:00:00Z',
      isDraft: false, reviewDecision: null, requestedTeams: [], linkedIssues: [], mergedAt: null, state: 'OPEN',
    };
    await applyDiscovery(db, config, {
      discoveredAt: '2026-08-31T12:00:00Z', githubLogin: 'cb1kenobi', warnings: [], issues: [],
      pullRequests: [
        { ...base, number: 10, title: 'Requested', url: 'https://example/10', requestedReviewers: ['cb1kenobi'] },
        { ...base, number: 11, title: 'Unrelated', url: 'https://example/11', requestedReviewers: ['someone-else'] },
      ],
    });
    expect(db.connection.prepare('SELECT number FROM review_queue').all()).toEqual([{ number: 10 }]);
    db.close();
  });
});
