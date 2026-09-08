import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { parseFeedbackAgentResult, runFeedbackAgent, type FeedbackClaim } from './feedback-agent.js';

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
  it('parses the final machine-readable result', () => {
    expect(parseFeedbackAgentResult('notes\nBARBARIAN_FEEDBACK_RESULT: {"status":"fixed","summary":"Done"}'))
      .toEqual({ status: 'fixed', summary: 'Done' });
    expect(() => parseFeedbackAgentResult('done')).toThrow('did not emit');
  });

  it('pushes a committed fix and reports it in the review room', async () => {
    const { database, claim } = setup();
    let pushed = false;
    await runFeedbackAgent(database, config, claim, undefined, {
      fetchBundle: async () => ({
        repository: 'Acme/repo', number: 15, metadata: { headRefOid: 'head-1' },
        diff: '', inlineComments: [{ body: 'Fix it' }], issueComments: [],
      }),
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1' }),
      execute: async () => 'BARBARIAN_FEEDBACK_RESULT: {"status":"fixed","summary":"Fixed the edge case."}',
      pushWorkspace: async () => { pushed = true; return 'head-2'; },
    });

    expect(pushed).toBe(true);
    expect(database.connection.prepare(`
      SELECT last_feedback_handled_watermark, feedback_claim_owner, feedback_needs_input
      FROM review_queue WHERE id=?
    `).get(claim.reviewId)).toEqual({
      last_feedback_handled_watermark: 'watermark-1', feedback_claim_owner: null, feedback_needs_input: 0,
    });
    expect(database.connection.prepare('SELECT content FROM chat_messages WHERE review_id=?').get(claim.reviewId))
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
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1' }),
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
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1' }),
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
      prepareWorkspace: async () => ({ path: '/tmp/feedback', initialHeadSha: 'head-1' }),
      execute: async () => { throw new Error('provider unavailable'); },
    })).rejects.toThrow('provider unavailable');
    expect(database.connection.prepare(`
      SELECT status, error FROM agent_runs WHERE review_id=? AND task='address_feedback'
    `).get(claim.reviewId)).toEqual({ status: 'failed', error: 'provider unavailable' });
    database.close();
  });
});
