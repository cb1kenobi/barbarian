import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { AgentRuntime } from './agent-runtime.js';
import { FeedbackDispatcher } from './feedback-dispatcher.js';
import type { FeedbackClaim } from './feedback-agent.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function testConfig(maxAutomaticAttempts = 3): BarbarianConfig {
  return {
    version: 1,
    server: { bindAddress: '127.0.0.1', port: 4142, trustedHosts: [] },
    desktop: { launchAtLogin: false, globalShortcut: '' },
    profile: { name: 'Chris', reviewName: '', timezone: 'UTC', githubLogin: 'cb1kenobi' },
    appearance: { theme: 'dark', fontSize: 'small', weapon: 'double-axe' },
    monitor: { intervalMinutes: 20, runOnStartup: true },
    repositories: [],
    review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
    linear: { enabled: false, command: [] },
    agents: {
      autoReview: true,
      autoAddressFeedback: true,
      maxConcurrent: 1,
      maxAutomaticAttempts,
      retryBaseMinutes: 1,
      maxRunsPerPullRequestPerHour: 3,
      codeReview: [],
      chat: { provider: 'codex', model: '', effort: '' },
      reviewRouting: 'round_robin',
      usageHeadroomPercent: 20,
      providers: { codex: { command: 'codex', args: [] } },
    },
    statusUpdate: { enabled: false, workdays: [], daysOff: [] },
  };
}

function testDatabase(): BarbarianDatabase {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-feedback-dispatcher-'));
  directories.push(directory);
  return new BarbarianDatabase(path.join(directory, 'test.db'));
}

function seedReview(database: BarbarianDatabase, author = 'cb1kenobi'): string {
  const id = 'github:Acme/repo#15';
  const now = new Date().toISOString();
  database.connection.prepare(`
    INSERT INTO review_queue(
      id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
      discussion_watermark, first_seen_at, updated_at, last_seen_at
    ) VALUES (?, 'Acme/repo', 15, 'Feedback', 'https://example.test/pr/15', ?, 'head-1',
      'feature', 'main', 'watermark-1', ?, ?, ?)
  `).run(id, author, now, now, now);
  return id;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

describe('FeedbackDispatcher', () => {
  it('claims each new feedback watermark on an authored pull request exactly once', async () => {
    const database = testDatabase();
    const id = seedReview(database);
    const runtime = new AgentRuntime(1);
    const claims: FeedbackClaim[] = [];
    const runner = async (runnerDatabase: BarbarianDatabase, _config: BarbarianConfig, claim: FeedbackClaim) => {
      claims.push(claim);
      runnerDatabase.connection.prepare(`
        UPDATE review_queue SET last_feedback_handled_watermark=?, feedback_claim_owner=NULL,
          feedback_claimed_at=NULL WHERE id=? AND feedback_claim_owner=?
      `).run(claim.feedbackWatermark, claim.reviewId, claim.owner);
    };
    const dispatcher = new FeedbackDispatcher(database, testConfig(), runtime, { error: () => undefined }, runner);

    await dispatcher.pump();
    await waitFor(() => claims.length === 1);
    await dispatcher.pump();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ reviewId: id, feedbackWatermark: 'watermark-1', attemptCount: 1 });

    database.connection.prepare(`
      UPDATE review_queue SET discussion_watermark='watermark-2', updated_at=? WHERE id=?
    `).run(new Date().toISOString(), id);
    await dispatcher.pump();
    await waitFor(() => claims.length === 2);
    expect(claims[1]).toMatchObject({ feedbackWatermark: 'watermark-2', previousHandledWatermark: 'watermark-1' });

    dispatcher.stop();
    await runtime.shutdown();
    database.close();
  });

  it('ignores feedback on pull requests not authored by the configured user', async () => {
    const database = testDatabase();
    seedReview(database, 'someone-else');
    let ran = false;
    const runtime = new AgentRuntime(1);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), runtime, { error: () => undefined }, async () => { ran = true; },
    );
    await dispatcher.pump();
    expect(ran).toBe(false);
    dispatcher.stop();
    await runtime.shutdown();
    database.close();
  });

  it('treats an unresolved AI review finding as feedback even without a trusted-discussion watermark', async () => {
    const database = testDatabase();
    const id = seedReview(database);
    database.connection.prepare("UPDATE review_queue SET discussion_watermark='' WHERE id=?").run(id);
    database.connection.prepare(`
      INSERT INTO review_findings(
        id, review_id, remote_id, author, body, summary, url, resolved, outdated, created_at, updated_at
      ) VALUES ('finding-1', ?, 42, 'review-bot', 'Fix this', 'Fix this', 'https://example.test/finding',
        0, 0, '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z')
    `).run(id);
    database.connection.prepare('UPDATE review_findings SET trusted_for_feedback=1 WHERE id=\'finding-1\'').run();
    const claims: FeedbackClaim[] = [];
    const runtime = new AgentRuntime(1);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), runtime, { error: () => undefined },
      async (runnerDatabase, _config, claim) => {
        claims.push(claim);
        runnerDatabase.connection.prepare(`
          UPDATE review_queue SET last_feedback_handled_watermark=?, feedback_claim_owner=NULL WHERE id=?
        `).run(claim.feedbackWatermark, claim.reviewId);
      },
    );
    await dispatcher.pump();
    await waitFor(() => claims.length === 1);
    expect(claims[0]?.feedbackWatermark).toContain('2026-09-08T12:00:00Z');
    dispatcher.stop();
    await runtime.shutdown();
    database.close();
  });

  it('does not dispatch for an AI-looking finding from an untrusted account', async () => {
    const database = testDatabase();
    const id = seedReview(database);
    database.connection.prepare("UPDATE review_queue SET discussion_watermark='' WHERE id=?").run(id);
    database.connection.prepare(`
      INSERT INTO review_findings(
        id, review_id, remote_id, author, body, summary, url, trusted_for_feedback,
        resolved, outdated, created_at, updated_at
      ) VALUES ('finding-1', ?, 42, 'claude-lookalike', 'Fix this', 'Fix this',
        'https://example.test/finding', 0, 0, 0, '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z')
    `).run(id);
    let ran = false;
    const runtime = new AgentRuntime(1);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), runtime, { error: () => undefined }, async () => { ran = true; },
    );
    await dispatcher.pump();
    expect(ran).toBe(false);
    dispatcher.stop();
    await runtime.shutdown();
    database.close();
  });

  it('does not let bot feedback on an AI-pushed head create a push loop', async () => {
    const database = testDatabase();
    const id = seedReview(database);
    database.connection.prepare(`
      UPDATE review_queue SET discussion_watermark='', last_feedback_pushed_sha=head_sha WHERE id=?
    `).run(id);
    database.connection.prepare(`
      INSERT INTO review_findings(
        id, review_id, remote_id, author, body, summary, url, trusted_for_feedback,
        resolved, outdated, created_at, updated_at
      ) VALUES ('finding-1', ?, 42, 'review-bot', 'Fix this', 'Fix this',
        'https://example.test/finding', 1, 0, 0, '2026-09-08T12:00:00Z', '2026-09-08T12:00:00Z')
    `).run(id);
    let ran = false;
    const runtime = new AgentRuntime(1);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), runtime, { error: () => undefined }, async () => { ran = true; },
    );
    await dispatcher.pump();
    expect(ran).toBe(false);
    dispatcher.stop();
    await runtime.shutdown();
    database.close();
  });

  it('notifies the review room when automatic attempts are exhausted', async () => {
    const database = testDatabase();
    const id = seedReview(database);
    const runtime = new AgentRuntime(1);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(1), runtime, { error: () => undefined }, async () => { throw new Error('workspace unavailable'); },
    );
    await dispatcher.pump();
    await waitFor(() => (database.connection.prepare(`
      SELECT feedback_needs_input FROM review_queue WHERE id=?
    `).get(id) as { feedback_needs_input: number } | undefined)?.feedback_needs_input === 1);

    expect(database.connection.prepare(`
      SELECT last_feedback_handled_watermark, feedback_needs_input, feedback_last_error
      FROM review_queue WHERE id=?
    `).get(id)).toEqual({
      last_feedback_handled_watermark: 'watermark-1',
      feedback_needs_input: 1,
      feedback_last_error: 'workspace unavailable',
    });
    expect(database.connection.prepare(`
      SELECT content FROM chat_messages WHERE review_id=?
    `).get(id)).toMatchObject({ content: expect.stringContaining('workspace unavailable') });

    dispatcher.stop();
    await runtime.shutdown();
    database.close();
  });

  it('reopens the handled feedback after the developer answers in the review room', () => {
    const database = testDatabase();
    const id = seedReview(database);
    database.connection.prepare(`
      UPDATE review_queue SET last_feedback_handled_watermark='watermark-1',
        feedback_attempt_count=3, feedback_attempt_watermark='watermark-1',
        feedback_last_error='input required', feedback_needs_input=1 WHERE id=?
    `).run(id);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), new AgentRuntime(1), { error: () => undefined }, async () => undefined,
    );

    expect(dispatcher.resumeFeedbackAfterInput(id, 42)).toBe(true);
    expect(dispatcher.resumeFeedbackAfterInput(id, 43)).toBe(false);
    expect(database.connection.prepare(`
      SELECT last_feedback_handled_watermark, feedback_attempt_count, feedback_attempt_watermark,
        feedback_last_error, feedback_needs_input, feedback_input_message_id
      FROM review_queue WHERE id=?
    `).get(id)).toEqual({
      last_feedback_handled_watermark: '', feedback_attempt_count: 0,
      feedback_attempt_watermark: 'watermark-1', feedback_last_error: null, feedback_needs_input: 0,
      feedback_input_message_id: 42,
    });
    dispatcher.stop();
    database.close();
  });

  it('keeps accumulated feedback parked while a developer question is pending', async () => {
    const database = testDatabase();
    const id = seedReview(database);
    database.connection.prepare(`
      UPDATE review_queue SET discussion_watermark='watermark-2',
        last_feedback_handled_watermark='watermark-1', feedback_attempt_watermark='watermark-1',
        feedback_needs_input=1 WHERE id=?
    `).run(id);
    let ran = false;
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), new AgentRuntime(1), { error: () => undefined }, async () => { ran = true; },
    );

    await dispatcher.pump();
    expect(ran).toBe(false);
    expect(database.connection.prepare(`
      SELECT feedback_needs_input, feedback_claim_owner FROM review_queue WHERE id=?
    `).get(id)).toEqual({ feedback_needs_input: 1, feedback_claim_owner: null });
    dispatcher.stop();
    database.close();
  });

  it('recovers an interrupted feedback claim after a process restart', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-feedback-restart-'));
    directories.push(directory);
    const filename = path.join(directory, 'test.db');
    const first = new BarbarianDatabase(filename);
    const id = seedReview(first);
    const now = new Date().toISOString();
    first.connection.prepare(`
      UPDATE review_queue SET feedback_claim_owner='old-owner', feedback_claimed_at=?,
        feedback_attempt_count=1, feedback_attempt_watermark='watermark-1' WHERE id=?
    `).run(now, id);
    first.connection.prepare(`
      INSERT INTO agent_runs(review_id, provider, task, status, started_at, prompt)
      VALUES (?, 'codex', 'address_feedback', 'running', ?, 'sensitive feedback prompt')
    `).run(id, now);
    first.close();

    const restarted = new BarbarianDatabase(filename);
    const dispatcher = new FeedbackDispatcher(
      restarted, testConfig(), new AgentRuntime(1), { error: () => undefined }, async () => undefined,
    );
    dispatcher.recoverInterruptedRuns();
    expect(restarted.connection.prepare(`
      SELECT feedback_claim_owner, feedback_retry_after, feedback_last_error FROM review_queue WHERE id=?
    `).get(id)).toMatchObject({
      feedback_claim_owner: null,
      feedback_last_error: 'Barbarian restarted during this feedback fix',
      feedback_retry_after: expect.any(String),
    });
    expect(restarted.connection.prepare(`
      SELECT status, error, prompt FROM agent_runs WHERE review_id=? AND task='address_feedback'
    `).get(id)).toEqual({
      status: 'interrupted', error: 'Barbarian restarted during this feedback fix', prompt: '',
    });
    dispatcher.stop();
    restarted.close();
  });

  it('cancels a claimed fix when the pull request becomes a draft', () => {
    const database = testDatabase();
    const id = seedReview(database);
    const now = new Date().toISOString();
    database.connection.prepare(`
      UPDATE review_queue SET is_draft=1, feedback_claim_owner='owner-1',
        feedback_claimed_at=?, feedback_attempt_watermark='watermark-1' WHERE id=?
    `).run(now, id);
    database.connection.prepare(`
      INSERT INTO agent_runs(review_id, provider, task, status, started_at, prompt)
      VALUES (?, 'codex', 'address_feedback', 'running', ?, 'feedback prompt')
    `).run(id, now);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), new AgentRuntime(1), { error: () => undefined }, async () => undefined,
    );
    dispatcher.cancelIneligibleFeedback();
    expect(database.connection.prepare(`
      SELECT feedback_claim_owner, last_feedback_handled_watermark FROM review_queue WHERE id=?
    `).get(id)).toEqual({ feedback_claim_owner: null, last_feedback_handled_watermark: null });
    expect(database.connection.prepare(`
      SELECT status, prompt FROM agent_runs WHERE review_id=? AND task='address_feedback'
    `).get(id)).toEqual({ status: 'cancelled', prompt: '' });
    dispatcher.stop();
    database.close();
  });

  it('leaves disabled in-flight feedback eligible when automatic fixes are re-enabled', () => {
    const database = testDatabase();
    const id = seedReview(database);
    const now = new Date().toISOString();
    database.connection.prepare(`
      UPDATE review_queue SET feedback_claim_owner='owner-1', feedback_claimed_at=?,
        feedback_attempt_watermark='watermark-1' WHERE id=?
    `).run(now, id);
    database.connection.prepare(`
      INSERT INTO agent_runs(review_id, provider, task, status, started_at, prompt)
      VALUES (?, 'codex', 'address_feedback', 'running', ?, 'feedback prompt')
    `).run(id, now);
    const dispatcher = new FeedbackDispatcher(
      database, testConfig(), new AgentRuntime(1), { error: () => undefined }, async () => undefined,
    );

    dispatcher.cancelAllFeedback();
    expect(database.connection.prepare(`
      SELECT feedback_claim_owner, last_feedback_handled_watermark FROM review_queue WHERE id=?
    `).get(id)).toEqual({ feedback_claim_owner: null, last_feedback_handled_watermark: null });
    expect(database.connection.prepare(`
      SELECT status, error, prompt FROM agent_runs WHERE review_id=? AND task='address_feedback'
    `).get(id)).toEqual({
      status: 'cancelled', error: 'Automatic feedback fixes were disabled', prompt: '',
    });
    dispatcher.stop();
    database.close();
  });
});
