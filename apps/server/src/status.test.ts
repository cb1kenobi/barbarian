import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { buildStatusDraft } from './status.js';
import type { BarbarianConfig } from './types.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
  version: 1,
  profile: { name: 'Chris', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  appearance: { theme: 'dark', fontSize: 'small' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [
    { name: 'Acme/secondary', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} },
    { name: 'Acme/primary', priority: 100, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} },
  ],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    default: 'codex', autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: {},
  },
  statusUpdate: {
    enabled: true,
    workdays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    daysOff: [],
  },
};

function createDatabase(): BarbarianDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-status-test-'));
  directories.push(directory);
  return new BarbarianDatabase(path.join(directory, 'test.db'));
}

function insertWork(database: BarbarianDatabase, repository: string, number: number, title: string, priority: number): void {
  database.connection.prepare(`
    INSERT INTO work_items(
      id, provider, repository, number, kind, title, url, priority,
      first_seen_at, updated_at, last_seen_at
    ) VALUES (?, 'github', ?, ?, 'issue', ?, ?, ?, ?, ?, ?)
  `).run(
    `github:${repository}#${number}`, repository, number, title,
    `https://github.com/${repository}/issues/${number}`, priority,
    '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z', '2026-09-01T10:00:00Z',
  );
}

function insertReview(
  database: BarbarianDatabase,
  number: number,
  author: string,
  options: {
    repository?: string;
    status?: string;
    reviewDecision?: string | null;
    viewerState?: string | null;
    viewerSha?: string | null;
    discussionWatermark?: string;
    lastReviewedWatermark?: string | null;
    draft?: boolean;
  } = {},
): void {
  const repository = options.repository || 'Acme/primary';
  const headSha = `head-${number}`;
  database.connection.prepare(`
    INSERT INTO review_queue(
      id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
      status, review_decision, viewer_review_state, viewer_review_sha,
      discussion_watermark, last_reviewed_watermark, is_draft,
      first_seen_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'feature', 'main', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `github:${repository}#${number}`, repository, number, `Review ${number}`,
    `https://github.com/${repository}/pull/${number}`, author, headSha,
    options.status || 'unreviewed', options.reviewDecision ?? null,
    options.viewerState ?? null, options.viewerSha === 'HEAD' ? headSha : options.viewerSha ?? null,
    options.discussionWatermark || '', options.lastReviewedWatermark ?? null, options.draft ? 1 : 0,
    '2026-09-01T10:00:00Z', `2026-09-01T10:${String(number).padStart(2, '0')}:00Z`, '2026-09-01T10:00:00Z',
  );
}

describe('status draft', () => {
  it('summarizes reviews and continues exactly one unfinished ticket from the previous workday', () => {
    const database = createDatabase();
    insertWork(database, 'Acme/primary', 1, 'Highest configured work', 500);
    insertWork(database, 'Acme/secondary', 2, 'Finish the durable cursor', 5);
    database.connection.prepare(`
      INSERT INTO daily_statuses(workday, content, created_at, updated_at)
      VALUES ('2026-09-01', '* secondary - Finish the durable cursor', '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')
    `).run();

    insertReview(database, 10, 'another-author');
    insertReview(database, 11, 'another-author', { status: 'approved', viewerState: 'APPROVED', viewerSha: 'HEAD' });
    insertReview(database, 20, 'cb1kenobi', { status: 'issues_found' });
    insertReview(database, 21, 'cb1kenobi', { reviewDecision: 'CHANGES_REQUESTED' });
    insertReview(database, 22, 'cb1kenobi', { reviewDecision: 'APPROVED' });
    insertReview(database, 23, 'cb1kenobi', {
      discussionWatermark: '2026-09-01T12:00:00Z', lastReviewedWatermark: '2026-09-01T11:00:00Z',
    });
    insertReview(database, 24, 'cb1kenobi', { reviewDecision: 'APPROVED' });
    database.connection.prepare(`
      INSERT INTO review_findings(
        id, review_id, remote_id, author, body, summary, url, created_at, updated_at
      ) VALUES ('finding-24', 'github:Acme/primary#24', 24, 'reviewer', 'Still broken',
        'Still broken', 'https://example.test/finding/24', '2026-09-01T12:00:00Z', '2026-09-01T12:00:00Z')
    `).run();

    expect(buildStatusDraft(database, config, new Date('2026-09-02T15:00:00Z')).lines).toEqual([
      '* Code reviews - 1 PR needs my review',
      '* primary - Address feedback on PR #24: Review 24',
      '* primary - Address feedback on PR #23: Review 23',
      '* primary - Address feedback on PR #21: Review 21',
      '* primary - Address feedback on PR #20: Review 20',
      '* primary - Merge approved PR #22: Review 22',
      '* secondary - Continue issue #2: Finish the durable cursor',
    ]);
    database.close();
  });

  it('chooses the highest-priority issue within the highest-priority configured repository', () => {
    const database = createDatabase();
    insertWork(database, 'Acme/secondary', 1, 'Large score in the secondary repo', 10_000);
    insertWork(database, 'Acme/primary', 2, 'Lower issue priority', 10);
    insertWork(database, 'Acme/primary', 3, 'Highest issue in primary repo', 20);

    expect(buildStatusDraft(database, config, new Date('2026-09-02T15:00:00Z')).lines).toEqual([
      '* Code reviews - 0 PRs need my review',
      '* primary - Work on issue #3: Highest issue in primary repo',
    ]);
    database.close();
  });
});
