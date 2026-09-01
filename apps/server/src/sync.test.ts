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
  appearance: { theme: 'dark', fontSize: 'small' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [{ name: 'Acme/storage', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: ['Developers'], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    default: 'codex', autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: {},
  },
  statusUpdate: { enabled: true, workdays: ['monday'], daysOff: [] },
};

function database(): BarbarianDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-test-'));
  directories.push(directory);
  return new BarbarianDatabase(path.join(directory, 'test.db'));
}

describe('applyDiscovery', () => {
  it('keeps assignment and progress metadata for every discovered issue', async () => {
    const db = database();
    const base = { provider: 'github' as const, repository: 'Acme/storage', body: '', updatedAt: '2026-08-31T10:00:00Z', labels: [], assignees: [] as string[], milestone: null, priority: 10, priorityReasons: [] };
    const result: DiscoveryResult = {
      discoveredAt: '2026-08-31T12:00:00Z', githubLogin: 'cb1kenobi', warnings: [], pullRequests: [],
      issues: [
        { ...base, assignees: ['cb1kenobi'], number: 1, title: 'Actionable', url: 'https://example/1', duplicateOf: null, inProgressPr: null, fixedBy: null },
        { ...base, number: 2, title: 'Claimed', url: 'https://example/2', duplicateOf: null, inProgressPr: 'https://example/pr/2', fixedBy: null },
        { ...base, number: 3, title: 'Fixed', url: 'https://example/3', duplicateOf: null, inProgressPr: null, fixedBy: 'https://example/pr/3' },
        { ...base, number: 4, title: 'Duplicate', url: 'https://example/4', duplicateOf: '#1', inProgressPr: null, fixedBy: null },
      ],
    };
    await applyDiscovery(db, config, result);
    const rows = db.connection.prepare('SELECT number, status, assignees FROM work_items ORDER BY number').all();
    expect(rows).toEqual([
      { number: 1, status: 'queued', assignees: '["cb1kenobi"]' },
      { number: 2, status: 'in_progress', assignees: '[]' },
      { number: 3, status: 'already_fixed', assignees: '[]' },
      { number: 4, status: 'duplicate', assignees: '[]' },
    ]);
    db.close();
  });

  it('tracks requested and previously reviewed pull requests while ignoring unrelated ones', async () => {
    const db = database();
    const base = {
      provider: 'github' as const, repository: 'Acme/storage', body: '', author: 'author',
      headSha: 'abc', headRefName: 'feature', baseRefName: 'main', createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-31T10:00:00Z',
      additions: 42, deletions: 7,
      isDraft: false, reviewDecision: null, requestedTeams: [], linkedIssues: [], mergedAt: null, state: 'OPEN',
      reviewedBy: [], viewerReviewState: null, viewerReviewSha: null, otherApprovals: 0,
      discussionWatermark: '',
    };
    const discovery: DiscoveryResult = {
      discoveredAt: '2026-08-31T12:00:00Z', githubLogin: 'cb1kenobi', warnings: [], issues: [],
      pullRequests: [
        { ...base, number: 10, title: 'Requested', url: 'https://example/10', requestedReviewers: ['cb1kenobi'] },
        { ...base, number: 11, title: 'Unrelated', url: 'https://example/11', requestedReviewers: ['someone-else'] },
        { ...base, number: 12, title: 'Previously reviewed', url: 'https://example/12', requestedReviewers: [], reviewedBy: ['cb1kenobi'] },
        { ...base, number: 13, title: 'Reviewed by someone else', url: 'https://example/13', requestedReviewers: [], reviewedBy: ['someone-else'] },
      ],
    };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT number FROM review_queue ORDER BY number').all()).toEqual([
      { number: 10 },
      { number: 12 },
    ]);
    expect(db.connection.prepare('SELECT remote_updated_at, additions, deletions FROM review_queue WHERE number=10').get())
      .toEqual({ remote_updated_at: '2026-08-31T10:00:00Z', additions: 42, deletions: 7 });

    discovery.pullRequests[0] = {
      ...discovery.pullRequests[0]!, reviewDecision: 'APPROVED', otherApprovals: 1,
    };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT status FROM review_queue WHERE number=10').get())
      .toEqual({ status: 'unreviewed' });

    discovery.pullRequests[0] = {
      ...discovery.pullRequests[0]!, viewerReviewState: 'APPROVED', viewerReviewSha: 'abc',
    };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT status FROM review_queue WHERE number=10').get())
      .toEqual({ status: 'approved' });

    discovery.pullRequests[2] = { ...discovery.pullRequests[2]!, reviewedBy: [] };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT number FROM review_queue ORDER BY number').all()).toEqual([
      { number: 10 },
      { number: 12 },
    ]);

    db.connection.prepare('UPDATE review_queue SET review_paused=1 WHERE number=10').run();
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT review_paused FROM review_queue WHERE number=10').get())
      .toEqual({ review_paused: 1 });

    discovery.pullRequests[0] = { ...discovery.pullRequests[0]!, headSha: 'new-head' };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT review_paused FROM review_queue WHERE number=10').get())
      .toEqual({ review_paused: 0 });
    db.close();
  });
});
