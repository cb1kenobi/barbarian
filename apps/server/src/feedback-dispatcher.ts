import { randomUUID } from 'node:crypto';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import type { AgentRuntime } from './agent-runtime.js';
import { authenticatedGithubLogin } from './github-identity.js';
import { agentProviderSupportsAutomaticWorkspaceWrite } from './agent-provider.js';
import { runFeedbackAgent, type FeedbackClaim } from './feedback-agent.js';

interface FeedbackCandidateRow {
  id: string;
  head_sha: string;
  feedback_watermark: string;
  last_feedback_handled_watermark: string | null;
  feedback_attempt_count: number;
  feedback_attempt_watermark: string | null;
  feedback_retry_after: string | null;
}

type FeedbackRunner = (
  database: BarbarianDatabase,
  config: BarbarianConfig,
  claim: FeedbackClaim,
  signal?: AbortSignal,
) => Promise<void>;

interface DispatcherLog {
  error(error: unknown, message?: string): void;
}

export class FeedbackDispatcher {
  readonly owner = `${process.pid}:${randomUUID()}`;
  private pumping = false;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;
  private reviewChanged: (reviewId: string) => void = () => undefined;
  private agentFinished: () => void = () => undefined;
  private readonly configSource: () => BarbarianConfig;
  private readonly runner: FeedbackRunner;

  constructor(
    private readonly database: BarbarianDatabase,
    config: BarbarianConfig | (() => BarbarianConfig),
    private readonly runtime: AgentRuntime,
    private readonly log: DispatcherLog,
    runner?: FeedbackRunner,
  ) {
    this.configSource = typeof config === 'function' ? config : () => config;
    this.runner = runner || runFeedbackAgent;
  }

  setReviewChangedListener(listener: (reviewId: string) => void): void {
    this.reviewChanged = listener;
  }

  setAgentFinishedListener(listener: () => void): void {
    this.agentFinished = listener;
  }

  private publishReviewChanged(reviewId: string): void {
    try { this.reviewChanged(reviewId); }
    catch (error) { this.log.error(error, `could not publish feedback update for ${reviewId}`); }
  }

  recoverInterruptedRuns(): void {
    const config = this.configSource();
    const rows = this.database.connection.prepare(`
      SELECT id, feedback_attempt_count, feedback_attempt_watermark
      FROM review_queue WHERE feedback_claim_owner IS NOT NULL
    `).all() as Array<{ id: string; feedback_attempt_count: number; feedback_attempt_watermark: string | null }>;
    const now = new Date();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      this.database.connection.prepare(`
        UPDATE agent_runs SET status='interrupted', finished_at=?,
          error='Barbarian restarted during this feedback fix', prompt=''
        WHERE status='running' AND task='address_feedback'
      `).run(now.toISOString());
      const release = this.database.connection.prepare(`
        UPDATE review_queue SET feedback_claim_owner=NULL, feedback_claimed_at=NULL,
          feedback_retry_after=?, feedback_last_error='Barbarian restarted during this feedback fix',
          feedback_needs_input=?, last_feedback_handled_watermark=CASE WHEN ?=1 THEN ? ELSE last_feedback_handled_watermark END,
          updated_at=? WHERE id=?
      `);
      for (const row of rows) {
        const exhausted = row.feedback_attempt_count >= config.agents.maxAutomaticAttempts;
        const retryAfter = exhausted ? null : new Date(
          now.getTime() + config.agents.retryBaseMinutes * 60_000 * (2 ** Math.max(0, row.feedback_attempt_count - 1)),
        ).toISOString();
        release.run(
          retryAfter,
          exhausted ? 1 : 0,
          exhausted ? 1 : 0,
          row.feedback_attempt_watermark || '',
          now.toISOString(),
          row.id,
        );
        if (exhausted) {
          this.database.connection.prepare(`
            INSERT INTO chat_messages(review_id, role, author, content, created_at)
            VALUES (?, 'assistant', 'Barbarian', ?, ?)
          `).run(
            row.id,
            `I couldn't address the latest review feedback automatically after ${row.feedback_attempt_count} attempts.\n\nBarbarian restarted during the last feedback fix.`,
            now.toISOString(),
          );
        }
      }
      this.database.connection.exec('COMMIT');
    } catch (error) {
      this.database.connection.exec('ROLLBACK');
      throw error;
    }
  }

  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    try {
      const config = this.configSource();
      while (!this.stopped && this.runtime.availableSlots > 0) {
        const claim = this.claimNext(config);
        if (!claim) break;
        this.publishReviewChanged(claim.reviewId);
        void this.runtime.run(async (signal) => {
          try {
            await this.runner(this.database, config, claim, signal);
          } catch (error) {
            if (!signal.aborted) this.failClaim(config, claim, error);
            throw error;
          }
        }, `${claim.reviewId}:feedback`).catch((error) => {
          if (!(error instanceof Error && error.name === 'AbortError')) {
            this.log.error(error, `feedback agent failed for ${claim.reviewId}`);
          }
        }).finally(() => {
          this.publishReviewChanged(claim.reviewId);
          try { this.agentFinished(); }
          catch (error) { this.log.error(error, 'could not wake the review dispatcher'); }
          void this.pump();
        });
      }
    } catch (error) {
      this.log.error(error, 'feedback dispatcher pump failed');
      this.retryTimer = setTimeout(() => { void this.pump(); }, 1_000);
    } finally {
      this.pumping = false;
      try { this.scheduleRetry(); }
      catch (error) {
        this.log.error(error, 'could not schedule a feedback retry');
        if (!this.stopped) this.retryTimer = setTimeout(() => { void this.pump(); }, 1_000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  cancelFeedback(reviewId: string): { found: boolean; stopped: boolean; cancelled: number } {
    const review = this.database.connection.prepare(`
      SELECT feedback_claim_owner, feedback_attempt_watermark FROM review_queue WHERE id=?
    `).get(reviewId) as {
      feedback_claim_owner: string | null;
      feedback_attempt_watermark: string | null;
    } | undefined;
    if (!review) return { found: false, stopped: false, cancelled: 0 };
    if (!review.feedback_claim_owner) return { found: true, stopped: false, cancelled: 0 };
    const cancelled = this.runtime.cancel(`${reviewId}:feedback`, new Error('Feedback fix stopped by user'));
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      this.database.connection.prepare(`
        UPDATE review_queue SET feedback_claim_owner=NULL, feedback_claimed_at=NULL,
          last_feedback_handled_watermark=COALESCE(feedback_attempt_watermark, last_feedback_handled_watermark),
          feedback_retry_after=NULL, feedback_last_error=NULL, feedback_needs_input=0, updated_at=?
        WHERE id=? AND feedback_claim_owner=?
      `).run(now, reviewId, review.feedback_claim_owner);
      this.database.connection.prepare(`
        UPDATE agent_runs SET status='cancelled', finished_at=?, error='Feedback fix stopped by user', prompt=''
        WHERE review_id=? AND task='address_feedback' AND status='running'
      `).run(now, reviewId);
      this.database.connection.exec('COMMIT');
    } catch (error) {
      this.database.connection.exec('ROLLBACK');
      throw error;
    }
    this.publishReviewChanged(reviewId);
    return { found: true, stopped: true, cancelled };
  }

  cancelIneligibleFeedback(): number {
    const rows = this.database.connection.prepare(`
      SELECT id, feedback_claim_owner FROM review_queue
      WHERE feedback_claim_owner IS NOT NULL AND (is_draft=1 OR remote_state<>'OPEN')
    `).all() as Array<{ id: string; feedback_claim_owner: string }>;
    let cancelled = 0;
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        cancelled += this.runtime.cancel(`${row.id}:feedback`, new Error('Pull request is no longer eligible for automatic fixes'));
        this.database.connection.prepare(`
          UPDATE review_queue SET feedback_claim_owner=NULL, feedback_claimed_at=NULL,
            feedback_retry_after=NULL, feedback_last_error=NULL, feedback_needs_input=0, updated_at=?
          WHERE id=? AND feedback_claim_owner=?
        `).run(now, row.id, row.feedback_claim_owner);
        this.database.connection.prepare(`
          UPDATE agent_runs SET status='cancelled', finished_at=?,
            error='Pull request is no longer eligible for automatic fixes', prompt=''
          WHERE review_id=? AND task='address_feedback' AND status='running'
        `).run(now, row.id);
      }
      this.database.connection.exec('COMMIT');
    } catch (error) {
      this.database.connection.exec('ROLLBACK');
      throw error;
    }
    for (const row of rows) this.publishReviewChanged(row.id);
    return cancelled;
  }

  resumeFeedbackAfterInput(reviewId: string, messageId: number): boolean {
    const changed = this.database.connection.prepare(`
      UPDATE review_queue SET last_feedback_handled_watermark='', feedback_attempt_count=0,
        feedback_retry_after=NULL, feedback_last_error=NULL,
        feedback_needs_input=0, feedback_input_message_id=?, updated_at=?
      WHERE id=? AND feedback_needs_input=1 AND feedback_claim_owner IS NULL
    `).run(messageId, new Date().toISOString(), reviewId);
    if (!changed.changes) return false;
    this.publishReviewChanged(reviewId);
    return true;
  }

  cancelAllFeedback(): number {
    const rows = this.database.connection.prepare(`
      SELECT id FROM review_queue WHERE feedback_claim_owner IS NOT NULL
    `).all() as Array<{ id: string }>;
    let cancelled = 0;
    for (const row of rows) {
      cancelled += this.runtime.cancel(`${row.id}:feedback`, new Error('Automatic feedback fixes were disabled'));
    }
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      this.database.connection.prepare(`
        UPDATE review_queue SET feedback_claim_owner=NULL, feedback_claimed_at=NULL,
          feedback_attempt_count=0, feedback_retry_after=NULL, feedback_last_error=NULL, updated_at=?
        WHERE feedback_claim_owner IS NOT NULL
      `).run(now);
      this.database.connection.prepare(`
        UPDATE agent_runs SET status='cancelled', finished_at=?,
          error='Automatic feedback fixes were disabled', prompt=''
        WHERE task='address_feedback' AND status='running'
      `).run(now);
      this.database.connection.exec('COMMIT');
    } catch (error) {
      this.database.connection.exec('ROLLBACK');
      throw error;
    }
    for (const row of rows) this.publishReviewChanged(row.id);
    return cancelled;
  }

  private claimNext(config: BarbarianConfig): FeedbackClaim | null {
    if (!config.agents.autoAddressFeedback) return null;
    const provider = config.agents.providers[config.agents.chat.provider];
    if (!provider || !agentProviderSupportsAutomaticWorkspaceWrite(provider.command)) return null;
    const login = authenticatedGithubLogin(
      this.database,
      config.profile.githubLogin || config.review.requestedReviewer,
    ).toLowerCase();
    if (!login) return null;
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database.connection.prepare(`
        SELECT * FROM (
          SELECT id, head_sha, last_feedback_handled_watermark, feedback_attempt_count,
            feedback_attempt_watermark, feedback_retry_after, updated_at,
            max(discussion_watermark, CASE
              WHEN head_sha<>COALESCE(last_feedback_pushed_sha, '') THEN COALESCE((
                SELECT max(review_findings.updated_at || '|' || printf('%024d', review_findings.remote_id))
                FROM review_findings WHERE review_findings.review_id=review_queue.id
                  AND review_findings.trusted_for_feedback=1
                  AND review_findings.resolved=0 AND review_findings.outdated=0
              ), '') ELSE '' END) AS feedback_watermark
          FROM review_queue
          WHERE remote_state='OPEN' AND is_draft=0 AND feedback_claim_owner IS NULL
            AND feedback_needs_input=0 AND lower(author)=?
        ) WHERE feedback_watermark<>''
          AND feedback_watermark>COALESCE(last_feedback_handled_watermark, '')
        ORDER BY updated_at ASC LIMIT 50
      `).all(login) as unknown as FeedbackCandidateRow[];
      for (const row of rows) {
        const sameAttempt = row.feedback_attempt_watermark === row.feedback_watermark;
        if (sameAttempt && row.feedback_attempt_count >= config.agents.maxAutomaticAttempts) continue;
        if (sameAttempt && row.feedback_retry_after && row.feedback_retry_after > now) continue;
        const since = new Date(Date.now() - 60 * 60_000).toISOString();
        const recentRuns = Number((this.database.connection.prepare(`
          SELECT COUNT(*) AS total FROM agent_runs
          WHERE review_id=? AND task='address_feedback' AND started_at>=?
        `).get(row.id, since) as { total: number }).total);
        if (recentRuns >= config.agents.maxRunsPerPullRequestPerHour) continue;
        const attemptCount = sameAttempt ? row.feedback_attempt_count + 1 : 1;
        const claimOwner = `${this.owner}:${randomUUID()}`;
        const changed = this.database.connection.prepare(`
          UPDATE review_queue SET feedback_claim_owner=?, feedback_claimed_at=?,
            feedback_attempt_count=?, feedback_attempt_watermark=?,
            feedback_input_message_id=CASE WHEN ?=1 THEN feedback_input_message_id ELSE NULL END,
            feedback_retry_after=NULL, feedback_last_error=NULL, updated_at=?
          WHERE id=? AND feedback_claim_owner IS NULL
        `).run(claimOwner, now, attemptCount, row.feedback_watermark, sameAttempt ? 1 : 0, now, row.id);
        if (!changed.changes) continue;
        this.database.connection.exec('COMMIT');
        return {
          reviewId: row.id,
          owner: claimOwner,
          headSha: row.head_sha,
          feedbackWatermark: row.feedback_watermark,
          previousHandledWatermark: row.last_feedback_handled_watermark || '',
          attemptCount,
        };
      }
      this.database.connection.exec('COMMIT');
      return null;
    } catch (error) {
      this.database.connection.exec('ROLLBACK');
      throw error;
    }
  }

  private failClaim(config: BarbarianConfig, claim: FeedbackClaim, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = claim.attemptCount >= config.agents.maxAutomaticAttempts;
    const retryAfter = exhausted ? null : new Date(
      Date.now() + config.agents.retryBaseMinutes * 60_000 * (2 ** Math.max(0, claim.attemptCount - 1)),
    ).toISOString();
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.database.connection.prepare(`
        UPDATE review_queue SET feedback_claim_owner=NULL, feedback_claimed_at=NULL,
          feedback_retry_after=?, feedback_last_error=?, feedback_needs_input=?,
          last_feedback_handled_watermark=CASE WHEN ?=1 THEN ? ELSE last_feedback_handled_watermark END,
          updated_at=? WHERE id=? AND feedback_claim_owner=?
      `).run(
        retryAfter,
        message.slice(0, 4_000),
        exhausted ? 1 : 0,
        exhausted ? 1 : 0,
        claim.feedbackWatermark,
        now,
        claim.reviewId,
        claim.owner,
      );
      if (changed.changes && exhausted) {
        this.database.connection.prepare(`
          INSERT INTO chat_messages(review_id, role, author, content, created_at)
          VALUES (?, 'assistant', 'Barbarian', ?, ?)
        `).run(
          claim.reviewId,
          `I couldn't address the latest review feedback automatically after ${claim.attemptCount} attempts.\n\n${message.slice(0, 4_000)}`,
          now,
        );
      }
      this.database.connection.exec('COMMIT');
    } catch (failure) {
      this.database.connection.exec('ROLLBACK');
      throw failure;
    }
  }

  private scheduleRetry(): void {
    const config = this.configSource();
    if (this.stopped || this.retryTimer || !config.agents.autoAddressFeedback) return;
    const row = this.database.connection.prepare(`
      SELECT MIN(feedback_retry_after) AS retry_after FROM review_queue
      WHERE remote_state='OPEN' AND feedback_claim_owner IS NULL AND feedback_retry_after IS NOT NULL
        AND feedback_attempt_count < ?
    `).get(config.agents.maxAutomaticAttempts) as { retry_after: string | null };
    if (!row.retry_after) return;
    const delay = Math.max(0, new Date(row.retry_after).getTime() - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.pump();
    }, Math.min(delay, 2_147_000_000));
  }
}
