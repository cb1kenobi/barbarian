import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import {
  feedbackSourceRepository, parseFeedbackAgentResult, runFeedbackAgent, type FeedbackClaim,
} from './feedback-agent.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
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
    autoReview: true, autoAddressFeedback: true, maxConcurrent: 1, maxAutomaticAttempts: 3,
    retryBaseMinutes: 1, maxRunsPerPullRequestPerHour: 3, codeReview: [],
    chat: { provider: 'codex', model: '', effort: '' },
    reviewRouting: 'round_robin', usageHeadroomPercent: 20,
    providers: { codex: { command: 'codex', args: [] } },
  },
  statusUpdate: { enabled: false, workdays: [], daysOff: [] },
};

function setup(): { database: BarbarianDatabase; claim: FeedbackClaim } {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-feedback-agent-'));
  directories.push(directory);
  const database = new BarbarianDatabase(path.join(directory, 'test.db'));
  const id = 'github:Acme/repo#15';
  const now = new Date().toISOString();
  database.connection.prepare(`
    INSERT INTO review_queue(
      id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
      discussion_watermark, feedback_claim_owner, first_seen_at, updated_at, last_seen_at
    ) VALUES (?, 'Acme/repo', 15, 'Feedback', 'https://example.test/pr/15', 'cb1kenobi',
      'head-1', 'feature', 'main', 'watermark-1', 'owner-1', ?, ?, ?)
  `).run(id, now, now, now);
  return {
    database,
    claim: {
      reviewId: id, owner: 'owner-1', headSha: 'head-1', feedbackWatermark: 'watermark-1',
      previousHandledWatermark: '', attemptCount: 1,
    },
  };
}

describe('feedback agent result', () => {
  it('resolves same-repository and fork branch sources from GitHub metadata', () => {
    expect(feedbackSourceRepository('Acme/repo', { isCrossRepository: false })).toBe('Acme/repo');
    expect(feedbackSourceRepository('Acme/repo', {
      isCrossRepository: true,
      headRepository: { nameWithOwner: 'Contributor/repo' },
    })).toBe('Contributor/repo');
    expect(feedbackSourceRepository('Acme/repo', {
      isCrossRepository: true,
      headRepository: { name: 'repo' },
      headRepositoryOwner: { login: 'Contributor' },
    })).toBe('Contributor/repo');
    expect(feedbackSourceRepository('Acme/repo', { isCrossRepository: true })).toBe('');
  });

  it('parses the final machine-readable result', () => {
    expect(parseFeedbackAgentResult('notes\nBARBARIAN_FEEDBACK_RESULT: {"status":"fixed","summary":"Done"}'))
      .toEqual({ status: 'fixed', summary: 'Done', addressedCommentIds: [] });
    expect(() => parseFeedbackAgentResult('done')).toThrow('did not emit');
  });

  it('pushes a committed fix and reports it in the review room', async () => {
    const { database, claim } = setup();
    const configured = {
      ...config,
      repositories: [{
        name: 'Acme/repo', path: '/tmp/acme-repo', priority: 0,
        watchIssues: true, watchPullRequests: true,
        reviewSkill: 'cb1-code-review', feedbackSkill: 'harper-engineering-guidelines', labels: {},
      }],
    } satisfies BarbarianConfig;
    const input = database.connection.prepare(`
      INSERT INTO chat_messages(review_id, role, author, content, created_at)
      VALUES (?, 'user', 'Developer', 'Preserve the fallback behavior.', ?)
    `).run(claim.reviewId, new Date().toISOString());
    database.connection.prepare('UPDATE review_queue SET feedback_input_message_id=? WHERE id=?')
      .run(Number(input.lastInsertRowid), claim.reviewId);
    database.connection.prepare(`
      INSERT INTO review_findings(
        id, review_id, remote_id, author, body, summary, url, path, line,
        trusted_for_feedback, resolved, outdated, created_at, updated_at
      ) VALUES (?, ?, 101, 'gemini-code-assist', 'Fix it', 'Fix it', 'https://example.test/comment/101',
        'file.ts', 1, 1, 0, 0, ?, ?)
    `).run(`${claim.reviewId}:101`, claim.reviewId, new Date().toISOString(), new Date().toISOString());
    let pushed = false;
    let prompt = '';
    let acknowledged: unknown = null;
    await runFeedbackAgent(database, configured, claim, undefined, {
      fetchBundle: async () => ({
        repository: 'Acme/repo', number: 15, metadata: { headRefOid: 'head-1' },
        diff: '', inlineComments: [
          { id: 101, body: 'Fix it', in_reply_to_id: null, user: { login: 'gemini-code-assist', type: 'Bot' }, author_association: 'NONE' },
          { id: 102, body: 'Please preserve this case', user: { login: 'maintainer', type: 'User' }, author_association: 'MEMBER' },
          { id: 103, body: 'Untrusted', user: { login: 'visitor', type: 'User' }, author_association: 'NONE' },
          { id: 104, body: 'Existing reply', in_reply_to_id: 101, user: { login: 'review-bot', type: 'Bot' }, author_association: 'NONE' },
        ], issueComments: [],
      }),
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1', pushGuard: 'sandbox' }),
      execute: async (_database, _config, _reviewId, _task, value) => {
        prompt = value;
        return 'BARBARIAN_FEEDBACK_RESULT: {"status":"fixed","summary":"Fixed the edge case.","addressedCommentIds":[101,102,103,104]}';
      },
      commitWorkspace: async () => 'head-2',
      pushWorkspace: async (_workspace, _repository, _branch, _head, _signal, pushGuard) => {
        expect(pushGuard).toBe('sandbox');
        pushed = true;
        return 'head-2';
      },
      acknowledge: async (repository, number, feedback, body) => {
        expect(database.connection.prepare(`
          SELECT feedback_claim_owner, last_feedback_pushed_sha FROM review_queue WHERE id=?
        `).get(claim.reviewId)).toEqual({ feedback_claim_owner: null, last_feedback_pushed_sha: 'head-2' });
        acknowledged = { repository, number, feedback, body };
      },
    });

    expect(pushed).toBe(true);
    expect(prompt).toContain('Preserve the fallback behavior.');
    expect(prompt).toContain('TRUSTED_DEVELOPER_ANSWER_JSON');
    expect(prompt).toContain('submitted from Barbarian\'s interactive dashboard');
    expect(prompt).toContain('Do not commit or modify Git metadata');
    expect(prompt).toContain('use the harper-engineering-guidelines skill');
    expect(acknowledged).toEqual({
      repository: 'Acme/repo', number: 15,
      feedback: [{ id: 101, resolve: true }, { id: 102, resolve: false }],
      body: 'Addressed in `head-2`.',
    });
    expect(database.connection.prepare(`
      SELECT last_feedback_handled_watermark, feedback_claim_owner, feedback_needs_input,
        last_feedback_pushed_sha, head_sha, feedback_input_message_id
      FROM review_queue WHERE id=?
    `).get(claim.reviewId)).toEqual({
      last_feedback_handled_watermark: 'watermark-1', feedback_claim_owner: null,
      feedback_needs_input: 0, last_feedback_pushed_sha: 'head-2',
      head_sha: 'head-2', feedback_input_message_id: null,
    });
    expect(database.connection.prepare('SELECT content FROM chat_messages WHERE review_id=? ORDER BY id DESC LIMIT 1').get(claim.reviewId))
      .toMatchObject({ content: expect.stringContaining('head-2') });
    database.close();
  });

  it('surfaces a precise question in the review room when developer input is required', async () => {
    const { database, claim } = setup();
    await runFeedbackAgent(database, config, claim, undefined, {
      fetchBundle: async () => ({
        repository: 'Acme/repo', number: 15, metadata: { headRefOid: 'head-1' },
        diff: '', inlineComments: [], issueComments: [],
      }),
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1', pushGuard: 'sandbox' }),
      execute: async () => 'BARBARIAN_FEEDBACK_RESULT: {"status":"needs_input","summary":"Two valid behaviors exist.","question":"Which behavior should be preserved?"}',
      inspectWorkspace: async () => ({ clean: true, headSha: 'head-1' }),
    });

    expect(database.connection.prepare('SELECT feedback_needs_input FROM review_queue WHERE id=?').get(claim.reviewId))
      .toEqual({ feedback_needs_input: 1 });
    expect(database.connection.prepare('SELECT content FROM chat_messages WHERE review_id=?').get(claim.reviewId))
      .toMatchObject({ content: expect.stringContaining('Which behavior should be preserved?') });
    database.close();
  });

  it('records non-actionable feedback only when the agent leaves the checkout unchanged', async () => {
    const { database, claim } = setup();
    await runFeedbackAgent(database, config, claim, undefined, {
      fetchBundle: async () => ({
        repository: 'Acme/repo', number: 15, metadata: { headRefOid: 'head-1' },
        diff: '', inlineComments: [], issueComments: [],
      }),
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1', pushGuard: 'sandbox' }),
      execute: async () => 'BARBARIAN_FEEDBACK_RESULT: {"status":"no_change","summary":"The comment was praise."}',
      inspectWorkspace: async () => ({ clean: true, headSha: 'head-1' }),
    });
    expect(database.connection.prepare('SELECT feedback_needs_input FROM review_queue WHERE id=?').get(claim.reviewId))
      .toEqual({ feedback_needs_input: 0 });
    expect(database.connection.prepare('SELECT content FROM chat_messages WHERE review_id=?').get(claim.reviewId))
      .toMatchObject({ content: expect.stringContaining('no code change was needed') });
    database.close();
  });

  it('marks the durable agent run failed when execution throws', async () => {
    const { database, claim } = setup();
    await expect(runFeedbackAgent(database, config, claim, undefined, {
      fetchBundle: async () => ({
        repository: 'Acme/repo', number: 15, metadata: { headRefOid: 'head-1' },
        diff: '', inlineComments: [], issueComments: [],
      }),
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1', pushGuard: 'sandbox' }),
      execute: async () => { throw new Error('provider unavailable'); },
    })).rejects.toThrow('provider unavailable');
    expect(database.connection.prepare(`
      SELECT status, error FROM agent_runs WHERE review_id=? AND task='address_feedback'
    `).get(claim.reviewId)).toEqual({ status: 'failed', error: 'provider unavailable' });
    database.close();
  });
});
