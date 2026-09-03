import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { AgentRuntime } from './agent-runtime.js';
import { ReviewDispatcher, reviewTrigger } from './dispatcher.js';
import type { ReviewClaim } from './agents.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function config(maxConcurrent = 2): BarbarianConfig {
  return {
    version: 1,
  profile: { name: 'Chris', reviewName: '', timezone: 'UTC', githubLogin: 'cb1kenobi' },
    appearance: { theme: 'dark', fontSize: 'small', weapon: 'double-axe' },
    monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
    repositories: [],
    review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
    linear: { enabled: false, command: [] },
    agents: {
      default: 'fake', autoReview: true, maxConcurrent, maxAutomaticAttempts: 3,
      retryBaseMinutes: 1, maxRunsPerPullRequestPerHour: 3,
      providers: { fake: { command: process.execPath, args: [] } },
    },
    statusUpdate: { enabled: false, workdays: [], daysOff: [] },
  };
}

function database(filename?: string): BarbarianDatabase {
  if (filename) return new BarbarianDatabase(filename);
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-dispatcher-'));
  directories.push(directory);
  return new BarbarianDatabase(path.join(directory, 'test.db'));
}

function seedReview(db: BarbarianDatabase, number: number, head = `head-${number}`): string {
  const id = `github:Acme/repo#${number}`;
  const now = new Date().toISOString();
  db.connection.prepare(`
    INSERT INTO review_queue(
      id, repository, number, title, simple_summary, plain_summary, body, url, author,
      head_sha, head_ref_name, base_ref_name, requested_reviewers, requested_teams,
      linked_issues, review_skill, first_seen_at, updated_at, last_seen_at
    ) VALUES (?, 'Acme/repo', ?, 'Title', '', '', '', 'https://example.test/pr', 'author',
      ?, 'feature', 'main', '[]', '[]', '[]', 'cb1-code-review', ?, ?, ?)
  `).run(id, number, head, now, now, now);
  return id;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

describe('reviewTrigger', () => {
  it('derives new PR, commit, and feedback work from successful checkpoints', () => {
    expect(reviewTrigger({ manual_requested_at: null, head_sha: 'a', last_reviewed_sha: null, discussion_watermark: '', last_reviewed_watermark: null })).toBe('new_pr');
    expect(reviewTrigger({ manual_requested_at: null, head_sha: 'b', last_reviewed_sha: 'a', discussion_watermark: '', last_reviewed_watermark: '' })).toBe('new_commits');
    expect(reviewTrigger({ manual_requested_at: null, head_sha: 'a', last_reviewed_sha: 'a', discussion_watermark: '2026-09-02', last_reviewed_watermark: '2026-09-01' })).toBe('feedback');
    expect(reviewTrigger({ manual_requested_at: null, head_sha: 'a', last_reviewed_sha: 'a', discussion_watermark: 'same', last_reviewed_watermark: 'same' })).toBeNull();
  });
});

describe('ReviewDispatcher', () => {
  it('does not automatically review pull requests authored by the configured user', async () => {
    const db = database();
    const id = seedReview(db, 7);
    db.connection.prepare("UPDATE review_queue SET author='CB1Kenobi' WHERE id=?").run(id);
    let claimed = false;
    const dispatcher = new ReviewDispatcher(
      db, config(1), new AgentRuntime(1), { error: () => undefined },
      async () => { claimed = true; },
    );
    await dispatcher.pump();
    expect(claimed).toBe(false);
    expect(db.connection.prepare('SELECT status, claim_owner FROM review_queue WHERE id=?').get(id))
      .toEqual({ status: 'unreviewed', claim_owner: null });
    dispatcher.stop();
    db.close();
  });

  it('re-reviews an approved PR when its head advances', async () => {
    const db = database();
    const id = seedReview(db, 11, 'new-head');
    db.connection.prepare(`
      UPDATE review_queue SET status='approved', last_reviewed_sha='old-head',
        approval_carryover=1 WHERE id=?
    `).run(id);
    const runtime = new AgentRuntime(1);
    let claim: ReviewClaim | undefined;
    const runner = async (runnerDb: BarbarianDatabase, _config: BarbarianConfig, nextClaim: ReviewClaim) => {
      claim = nextClaim;
      runnerDb.connection.prepare(`
        UPDATE review_queue SET status='approved', last_reviewed_sha=head_sha,
          claim_owner=NULL, claimed_at=NULL WHERE id=? AND claim_owner=?
      `).run(nextClaim.reviewId, nextClaim.owner);
    };
    const dispatcher = new ReviewDispatcher(db, config(1), runtime, { error: () => undefined }, runner);
    await dispatcher.pump();
    await waitFor(() => Boolean(claim));
    expect(claim).toMatchObject({ reviewId: id, trigger: 'new_commits', headSha: 'new-head' });
    dispatcher.stop();
    await runtime.shutdown();
    db.close();
  });

  it('marks incomplete sync and agent records as interrupted on startup', () => {
    const db = database();
    const id = seedReview(db, 8);
    const now = new Date().toISOString();
    db.connection.prepare("INSERT INTO sync_runs(started_at,status) VALUES (?,'running')").run(now);
    db.connection.prepare(`
      INSERT INTO agent_runs(review_id,provider,task,status,started_at,prompt)
      VALUES (?,'fake','code_review:new_pr','running',?,'sensitive prompt')
    `).run(id, now);
    db.connection.prepare("UPDATE review_queue SET claim_owner='old-owner',claimed_at=?,attempt_count=1 WHERE id=?")
      .run(now, id);
    db.connection.prepare(`
      INSERT INTO local_branches(
        id, repository, remote_url, branch_name, base_branch, base_ref, head_sha,
        workspace_path, status, first_seen_at, updated_at, last_seen_at
      ) VALUES ('branch:test', 'Acme/repo', 'git@github.com:Acme/repo.git', 'feature',
        'main', 'origin/main', 'head', '/tmp', 'agent_working', ?, ?, ?)
    `).run(now, now, now);
    const dispatcher = new ReviewDispatcher(db, config(), new AgentRuntime(1), { error: () => undefined });
    dispatcher.recoverInterruptedRuns();
    expect(db.connection.prepare('SELECT status,error FROM sync_runs').get())
      .toEqual({ status: 'failed', error: 'Barbarian restarted during this sync' });
    expect(db.connection.prepare('SELECT status,error,prompt FROM agent_runs').get())
      .toEqual({ status: 'interrupted', error: 'Barbarian restarted during this run', prompt: '' });
    expect(db.connection.prepare('SELECT status,claim_owner,retry_after FROM review_queue WHERE id=?').get(id))
      .toMatchObject({ status: 'agent_failed', claim_owner: null });
    expect(db.connection.prepare('SELECT status,last_agent_error FROM local_branches WHERE id=?').get('branch:test'))
      .toEqual({ status: 'unreviewed', last_agent_error: 'Barbarian restarted during this run' });
    dispatcher.stop();
    db.close();
  });

  it('wires eligible rows to exactly one bounded agent run', async () => {
    const db = database();
    const ids = [seedReview(db, 1), seedReview(db, 2), seedReview(db, 3)];
    const runtime = new AgentRuntime(2);
    const claims: ReviewClaim[] = [];
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const runner = async (runnerDb: BarbarianDatabase, _config: BarbarianConfig, claim: ReviewClaim) => {
      claims.push(claim);
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      runnerDb.connection.prepare(`
        UPDATE review_queue SET last_reviewed_sha=?, last_reviewed_watermark=?,
          claim_owner=NULL, claimed_at=NULL, status='ready_to_merge' WHERE id=? AND claim_owner=?
      `).run(claim.headSha, claim.discussionWatermark, claim.reviewId, claim.owner);
      active -= 1;
    };
    const dispatcher = new ReviewDispatcher(db, config(), runtime, { error: () => undefined }, runner);
    await dispatcher.pump();
    await waitFor(() => claims.length === 2);
    expect(maximum).toBe(2);
    await dispatcher.pump();
    expect(claims).toHaveLength(2);
    releases.splice(0).forEach((release) => release());
    await waitFor(() => claims.length === 3);
    releases.splice(0).forEach((release) => release());
    await waitFor(() => active === 0);
    expect(new Set(claims.map((claim) => claim.reviewId))).toEqual(new Set(ids));
    dispatcher.stop();
    await runtime.shutdown();
    db.close();
  });

  it('publishes dashboard updates when a review starts and finishes', async () => {
    const db = database();
    const id = seedReview(db, 4);
    const runtime = new AgentRuntime(1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = async (runnerDb: BarbarianDatabase, _config: BarbarianConfig, claim: ReviewClaim) => {
      await gate;
      runnerDb.connection.prepare(`
        UPDATE review_queue SET last_reviewed_sha=?, last_reviewed_watermark=?,
          claim_owner=NULL, claimed_at=NULL, status='ready_to_merge'
        WHERE id=? AND claim_owner=?
      `).run(claim.headSha, claim.discussionWatermark, claim.reviewId, claim.owner);
    };
    const changes: string[] = [];
    const dispatcher = new ReviewDispatcher(db, config(1), runtime, { error: () => undefined }, runner);
    dispatcher.setReviewChangedListener((reviewId) => changes.push(reviewId));
    await dispatcher.pump();
    await waitFor(() => changes.length === 1);
    expect(changes).toEqual([id]);
    release();
    await waitFor(() => changes.length === 2);
    expect(changes).toEqual([id, id]);
    dispatcher.stop();
    await runtime.shutdown();
    db.close();
  });

  it('prevents two database connections from claiming the same PR', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-claim-'));
    directories.push(directory);
    const filename = path.join(directory, 'test.db');
    const firstDb = database(filename);
    seedReview(firstDb, 1);
    const secondDb = database(filename);
    const firstRuntime = new AgentRuntime(1);
    const secondRuntime = new AgentRuntime(1);
    const claims: ReviewClaim[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runner = async (runnerDb: BarbarianDatabase, _config: BarbarianConfig, claim: ReviewClaim) => {
      claims.push(claim);
      await gate;
      runnerDb.connection.prepare(`
        UPDATE review_queue SET last_reviewed_sha=?, last_reviewed_watermark=?, claim_owner=NULL,
          status='ready_to_merge' WHERE id=? AND claim_owner=?
      `).run(claim.headSha, claim.discussionWatermark, claim.reviewId, claim.owner);
    };
    const first = new ReviewDispatcher(firstDb, config(1), firstRuntime, { error: () => undefined }, runner);
    const second = new ReviewDispatcher(secondDb, config(1), secondRuntime, { error: () => undefined }, runner);
    await Promise.all([first.pump(), second.pump()]);
    await waitFor(() => claims.length === 1);
    expect(claims).toHaveLength(1);
    release();
    await waitFor(() => firstRuntime.availableSlots === 1 || secondRuntime.availableSlots === 1);
    first.stop();
    second.stop();
    await Promise.all([firstRuntime.shutdown(), secondRuntime.shutdown()]);
    firstDb.close();
    secondDb.close();
  });

  it('cancels a running review and keeps it paused until explicitly resumed', async () => {
    const db = database();
    const id = seedReview(db, 9);
    const runtime = new AgentRuntime(1);
    let runs = 0;
    const runner = async (_db: BarbarianDatabase, _config: BarbarianConfig, _claim: ReviewClaim, signal?: AbortSignal) => {
      runs += 1;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const dispatcher = new ReviewDispatcher(db, config(1), runtime, { error: () => undefined }, runner);
    await dispatcher.pump();
    await waitFor(() => runs === 1);
    expect(dispatcher.cancelReview(id)).toMatchObject({ found: true, cancelled: 1 });
    await waitFor(() => runtime.availableSlots === 1);
    await dispatcher.pump();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toBe(1);
    expect(db.connection.prepare(`
      SELECT status, review_paused, claim_owner, manual_requested_at FROM review_queue WHERE id=?
    `).get(id)).toEqual({ status: 'unreviewed', review_paused: 1, claim_owner: null, manual_requested_at: null });
    dispatcher.stop();
    expect(dispatcher.requestManual(id)).toBe(true);
    expect(db.connection.prepare('SELECT review_paused, manual_requested_at IS NOT NULL AS requested FROM review_queue WHERE id=?')
      .get(id)).toEqual({ review_paused: 0, requested: 1 });
    await runtime.shutdown();
    db.close();
  });

  it('does not hide a review-room chat when stopping the code review', async () => {
    const db = database();
    const id = seedReview(db, 15);
    const now = new Date().toISOString();
    db.connection.prepare(`
      UPDATE review_queue SET status='agent_working', claim_owner='owner', claimed_at=? WHERE id=?
    `).run(now, id);
    db.connection.prepare(`
      INSERT INTO agent_runs(review_id, provider, task, status, started_at, runtime_key)
      VALUES (?, 'fake', 'chat', 'running', ?, 'agent-run:chat')
    `).run(id, now);
    const dispatcher = new ReviewDispatcher(db, config(1), new AgentRuntime(1), { error: () => undefined });
    expect(dispatcher.cancelReview(id)).toMatchObject({ found: true, stopped: true, cancelled: 0 });
    expect(db.connection.prepare('SELECT status FROM agent_runs WHERE runtime_key=\'agent-run:chat\'').get())
      .toEqual({ status: 'running' });
    dispatcher.stop();
    db.close();
  });

  it('does not reset a review that finished before a stale stop click arrives', () => {
    const db = database();
    const id = seedReview(db, 10);
    db.connection.prepare("UPDATE review_queue SET status='ready_to_merge', last_reviewed_sha=head_sha WHERE id=?").run(id);
    const runtime = new AgentRuntime(1);
    const dispatcher = new ReviewDispatcher(db, config(1), runtime, { error: () => undefined });
    expect(dispatcher.cancelReview(id)).toEqual({ found: true, stopped: false, cancelled: 0 });
    expect(db.connection.prepare('SELECT status, review_paused FROM review_queue WHERE id=?').get(id))
      .toEqual({ status: 'ready_to_merge', review_paused: 0 });
    dispatcher.stop();
    db.close();
  });
});

describe('AgentRuntime', () => {
  it('shares one concurrency ceiling across callers', async () => {
    const runtime = new AgentRuntime(2);
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 6 }, () => runtime.run(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    }));
    await Promise.all(tasks);
    expect(maximum).toBe(2);
    await runtime.shutdown();
  });

  it('cancels every active task for one review without stopping another review', async () => {
    const runtime = new AgentRuntime(2);
    let releaseOther!: () => void;
    const stopped = runtime.run((signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'review-1');
    const other = runtime.run(() => new Promise<void>((resolve) => { releaseOther = resolve; }), 'review-2');
    await waitFor(() => runtime.availableSlots === 0);
    expect(runtime.cancel('review-1')).toBe(1);
    await expect(stopped).rejects.toThrow('Stopped by user');
    releaseOther();
    await other;
    expect(runtime.availableSlots).toBe(2);
    await runtime.shutdown();
  });
});
