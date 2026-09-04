import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { applyDiscovery } from './sync.js';
import type { BarbarianConfig, DiscoveryResult } from './types.js';
import { AgentRuntime } from './agent-runtime.js';
import { ReviewDispatcher } from './dispatcher.js';
import type { ReviewClaim } from './agents.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
  version: 1,
  server: { bindAddress: '127.0.0.1', port: 4142, trustedHosts: [] },
  desktop: { launchAtLogin: false, globalShortcut: 'CommandOrControl+Shift+Space' },
  profile: { name: 'Chris', reviewName: '', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  appearance: { theme: 'dark', fontSize: 'small', weapon: 'double-axe' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [{ name: 'Acme/storage', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: ['Developers'], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    codeReview: { codex: { enabled: true, model: '', effort: '' } },
    chat: { provider: 'codex', model: '', effort: '' },
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: {},
  },
  statusUpdate: { enabled: true, workdays: ['monday'], daysOff: [] },
};

function database(): BarbarianDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-test-'));
  directories.push(directory);
  return new BarbarianDatabase(path.join(directory, 'test.db'));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
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
    expect(db.connection.prepare("SELECT value FROM app_metadata WHERE key='authenticated_github_login'").get())
      .toEqual({ value: 'cb1kenobi' });
    const rows = db.connection.prepare('SELECT number, status, assignees FROM work_items ORDER BY number').all();
    expect(rows).toEqual([
      { number: 1, status: 'queued', assignees: '["cb1kenobi"]' },
      { number: 2, status: 'in_progress', assignees: '[]' },
      { number: 3, status: 'already_fixed', assignees: '[]' },
      { number: 4, status: 'duplicate', assignees: '[]' },
    ]);
    await applyDiscovery(db, config, { ...result, discoveredAt: '2026-08-31T12:01:00Z', issues: [] });
    expect(db.connection.prepare('SELECT status, remote_state FROM work_items WHERE number=1').get())
      .toEqual({ status: 'unavailable', remote_state: 'MISSING' });
    await applyDiscovery(db, config, { ...result, discoveredAt: '2026-08-31T12:02:00Z' });
    expect(db.connection.prepare('SELECT status, remote_state FROM work_items WHERE number=1').get())
      .toEqual({ status: 'queued', remote_state: 'OPEN' });
    db.close();
  });

  it('tracks requested, previously reviewed, and authored pull requests while ignoring unrelated ones', async () => {
    const db = database();
    const base = {
      provider: 'github' as const, repository: 'Acme/storage', body: '', author: 'author',
      headSha: 'abc', headRefName: 'feature', baseRefName: 'main', createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-31T10:00:00Z',
      additions: 42, deletions: 7, commitCount: 3,
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
        { ...base, number: 14, title: 'Authored by viewer', url: 'https://example/14', author: 'CB1Kenobi', requestedReviewers: ['someone-else'] },
      ],
    };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT number FROM review_queue ORDER BY number').all()).toEqual([
      { number: 10 },
      { number: 12 },
      { number: 14 },
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
    db.connection.prepare(`
      UPDATE review_queue SET last_reviewed_sha='abc', last_reviewed_commit_count=3 WHERE number=10
    `).run();

    discovery.pullRequests[2] = { ...discovery.pullRequests[2]!, reviewedBy: [] };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT number FROM review_queue ORDER BY number').all()).toEqual([
      { number: 10 },
      { number: 12 },
      { number: 14 },
    ]);

    db.connection.prepare('UPDATE review_queue SET review_paused=1 WHERE number=10').run();
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare('SELECT review_paused FROM review_queue WHERE number=10').get())
      .toEqual({ review_paused: 1 });

    discovery.pullRequests[0] = { ...discovery.pullRequests[0]!, headSha: 'new-head', commitCount: 5 };
    await applyDiscovery(db, config, discovery);
    expect(db.connection.prepare(`
      SELECT status, review_paused, approval_carryover, commit_count FROM review_queue WHERE number=10
    `).get()).toEqual({
      status: 'unreviewed', review_paused: 0, approval_carryover: 1, commit_count: 5,
    });
    db.close();
  });

  it('reviews a matching PR when it becomes ready and re-reviews each new head', async () => {
    const db = database();
    const runtime = new AgentRuntime(1);
    const automaticConfig: BarbarianConfig = {
      ...config,
      agents: { ...config.agents, autoReview: true },
    };
    const pullRequest = {
      provider: 'github' as const,
      repository: 'Acme/storage',
      number: 797,
      title: 'Bound a replication gap',
      body: '',
      url: 'https://example.test/pull/797',
      author: 'author',
      additions: 42,
      deletions: 7,
      commitCount: 1,
      headSha: 'first-head',
      headRefName: 'feature',
      baseRefName: 'main',
      createdAt: '2026-09-02T01:59:10Z',
      updatedAt: '2026-09-02T04:35:10Z',
      isDraft: true,
      reviewDecision: null,
      requestedReviewers: ['cb1kenobi'],
      requestedTeams: [],
      reviewedBy: [],
      viewerReviewState: null,
      viewerReviewSha: null,
      otherApprovals: 0,
      linkedIssues: [],
      mergedAt: null,
      state: 'OPEN',
      discussionWatermark: '',
    };
    const discovery: DiscoveryResult = {
      discoveredAt: '2026-09-02T04:36:00Z',
      githubLogin: 'cb1kenobi',
      warnings: [],
      issues: [],
      pullRequests: [pullRequest],
    };

    await applyDiscovery(db, automaticConfig, discovery);
    expect(db.connection.prepare('SELECT id FROM review_queue WHERE number=797').get()).toBeUndefined();

    const claims: ReviewClaim[] = [];
    const dispatcher = new ReviewDispatcher(
      db,
      automaticConfig,
      runtime,
      { error: () => undefined },
      async (runnerDb, _config, claim) => {
        claims.push(claim);
        runnerDb.connection.prepare(`
          UPDATE review_queue SET status='ready_to_merge', last_reviewed_sha=?,
            last_reviewed_watermark=?, claim_owner=NULL, claimed_at=NULL WHERE id=? AND claim_owner=?
        `).run(claim.headSha, claim.discussionWatermark, claim.reviewId, claim.owner);
      },
    );

    discovery.discoveredAt = '2026-09-02T23:05:00Z';
    discovery.pullRequests = [{
      ...pullRequest,
      isDraft: false,
      updatedAt: '2026-09-02T23:04:16Z',
    }];
    await applyDiscovery(db, automaticConfig, discovery);
    await dispatcher.pump();
    await waitFor(() => claims.length === 1 && runtime.availableSlots === 1);
    expect(claims[0]).toMatchObject({ reviewId: 'github:Acme/storage#797', trigger: 'new_pr', headSha: 'first-head' });

    discovery.discoveredAt = '2026-09-02T23:52:00Z';
    discovery.pullRequests = [{
      ...discovery.pullRequests[0]!,
      headSha: 'second-head',
      commitCount: 2,
      updatedAt: '2026-09-02T23:51:30Z',
    }];
    await applyDiscovery(db, automaticConfig, discovery);
    await dispatcher.pump();
    await waitFor(() => claims.length === 2 && runtime.availableSlots === 1);
    expect(claims[1]).toMatchObject({ reviewId: 'github:Acme/storage#797', trigger: 'new_commits', headSha: 'second-head' });

    dispatcher.stop();
    await runtime.shutdown();
    db.close();
  });
});
