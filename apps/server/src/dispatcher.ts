import { randomUUID } from 'node:crypto';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import type { ReviewClaim } from './agents.js';
import { runReviewAgent } from './agents.js';
import type { AgentRuntime } from './agent-runtime.js';

interface CandidateRow {
  id: string;
  status: string;
  head_sha: string;
  discussion_watermark: string;
  last_reviewed_sha: string | null;
  last_reviewed_watermark: string | null;
  manual_requested_at: string | null;
  manual_provider: string | null;
  review_paused: number;
  attempt_count: number;
  attempt_head_sha: string | null;
  attempt_watermark: string | null;
  retry_after: string | null;
}

type ReviewRunner = (
  database: BarbarianDatabase,
  config: BarbarianConfig,
  claim: ReviewClaim,
  signal?: AbortSignal,
) => Promise<void>;

interface DispatcherLog {
  error(error: unknown, message?: string): void;
  info?(details: unknown, message?: string): void;
}

export function reviewTrigger(row: Pick<
  CandidateRow,
  'manual_requested_at' | 'last_reviewed_sha' | 'head_sha' | 'last_reviewed_watermark' | 'discussion_watermark'
>): ReviewClaim['trigger'] | null {
  if (row.manual_requested_at) return 'manual';
  if (!row.last_reviewed_sha) return 'new_pr';
  if (row.head_sha !== row.last_reviewed_sha) return 'new_commits';
  if (row.last_reviewed_watermark !== null && row.discussion_watermark > row.last_reviewed_watermark) return 'feedback';
  return null;
}

export class ReviewDispatcher {
  readonly owner = `${process.pid}:${randomUUID()}`;
  private pumping = false;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly database: BarbarianDatabase,
    config: BarbarianConfig | (() => BarbarianConfig),
    private readonly runtime: AgentRuntime,
    private readonly log: DispatcherLog,
    private readonly runner: ReviewRunner = runReviewAgent,
  ) {
    this.configSource = typeof config === 'function' ? config : () => config;
  }

  private readonly configSource: () => BarbarianConfig;

  recoverInterruptedRuns(): void {
    const config = this.configSource();
    const now = new Date();
    const claimed = this.database.connection.prepare(`
      SELECT id, attempt_count FROM review_queue WHERE claim_owner IS NOT NULL
    `).all() as Array<{ id: string; attempt_count: number }>;
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      this.database.connection.prepare(`
        UPDATE sync_runs SET status='failed', finished_at=?, error='Barbarian restarted during this sync'
        WHERE status='running'
      `).run(now.toISOString());
      this.database.connection.prepare(`
        UPDATE agent_runs SET status='interrupted', finished_at=?, error='Barbarian restarted during this run'
        WHERE status='running'
      `).run(now.toISOString());
      const release = this.database.connection.prepare(`
        UPDATE review_queue SET status='agent_failed', claim_owner=NULL, claimed_at=NULL,
          retry_after=?, last_agent_error='Barbarian restarted during this run', updated_at=? WHERE id=?
      `);
      for (const row of claimed) {
        const retryAfter = row.attempt_count < config.agents.maxAutomaticAttempts
          ? new Date(now.getTime() + config.agents.retryBaseMinutes * 60_000 * (2 ** Math.max(0, row.attempt_count - 1))).toISOString()
          : null;
        release.run(retryAfter, now.toISOString(), row.id);
      }
      this.database.connection.exec('COMMIT');
    } catch (error) {
      this.database.connection.exec('ROLLBACK');
      throw error;
    }
  }

  requestManual(reviewId: string, provider?: string): boolean {
    const config = this.configSource();
    if (provider && !config.agents.providers[provider]) throw new Error(`Agent provider "${provider}" is not configured`);
    const now = new Date().toISOString();
    const result = this.database.connection.prepare(`
      UPDATE review_queue SET
        manual_requested_at=CASE WHEN claim_owner IS NULL THEN ? ELSE manual_requested_at END,
        manual_provider=CASE WHEN claim_owner IS NULL THEN ? ELSE manual_provider END,
        review_paused=0, status=CASE WHEN claim_owner IS NULL THEN 'unreviewed' ELSE status END, updated_at=?
      WHERE id=? AND remote_state='OPEN'
    `).run(now, provider || null, now, reviewId);
    if (result.changes) void this.pump();
    return Boolean(result.changes);
  }

  cancelReview(reviewId: string): { found: boolean; stopped: boolean; cancelled: number } {
    const review = this.database.connection.prepare(`
      SELECT status, claim_owner, manual_requested_at FROM review_queue
      WHERE id=? AND remote_state='OPEN'
    `).get(reviewId) as { status: string; claim_owner: string | null; manual_requested_at: string | null } | undefined;
    if (!review) return { found: false, stopped: false, cancelled: 0 };
    const running = Number((this.database.connection.prepare(`
      SELECT COUNT(*) AS total FROM agent_runs WHERE review_id=? AND status='running'
    `).get(reviewId) as { total: number }).total);
    const pending = review.status === 'agent_working' || review.claim_owner || review.manual_requested_at || running > 0;
    if (!pending) return { found: true, stopped: false, cancelled: 0 };

    const cancelled = this.runtime.cancel(reviewId, new Error('Agent review stopped by user'));
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database.connection.prepare(`
        UPDATE review_queue SET status='unreviewed', review_paused=1,
          claim_owner=NULL, claimed_at=NULL, manual_requested_at=NULL, manual_provider=NULL,
          retry_after=NULL, last_agent_error=NULL, updated_at=?
        WHERE id=? AND remote_state='OPEN'
      `).run(now, reviewId);
      this.database.connection.prepare(`
        UPDATE agent_runs SET status='cancelled', finished_at=?, error='Stopped by user'
        WHERE review_id=? AND status='running'
      `).run(now, reviewId);
      this.database.connection.exec('COMMIT');
      return { found: Boolean(result.changes), stopped: Boolean(result.changes), cancelled };
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
        void this.runtime.run((signal) => this.runner(this.database, config, claim, signal), claim.reviewId)
          .catch((error) => {
            if (!(error instanceof Error && error.name === 'AbortError')) {
              this.log.error(error, `review agent failed for ${claim.reviewId}`);
            }
          })
          .finally(() => { void this.pump(); });
      }
    } catch (error) {
      this.log.error(error, 'review dispatcher pump failed');
      this.retryTimer = setTimeout(() => { void this.pump(); }, 1_000);
    } finally {
      this.pumping = false;
      this.scheduleRetry();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private claimNext(config: BarbarianConfig): ReviewClaim | null {
    const now = new Date().toISOString();
    this.database.connection.exec('BEGIN IMMEDIATE');
    try {
      const rows = this.database.connection.prepare(`
        SELECT id, status, head_sha, discussion_watermark, last_reviewed_sha, last_reviewed_watermark,
          manual_requested_at, manual_provider, review_paused, attempt_count,
          attempt_head_sha, attempt_watermark, retry_after
        FROM review_queue
        WHERE remote_state='OPEN' AND is_draft=0 AND claim_owner IS NULL
          AND status NOT IN ('merged','closed')
          AND (manual_requested_at IS NOT NULL OR (?=1 AND review_paused=0))
        ORDER BY manual_requested_at IS NULL, updated_at ASC
        LIMIT 50
      `).all(config.agents.autoReview ? 1 : 0) as unknown as CandidateRow[];
      for (const row of rows) {
        const trigger = reviewTrigger(row);
        if (!trigger || (row.status === 'approved' && trigger !== 'manual')) continue;
        const sameAttempt = row.attempt_head_sha === row.head_sha && row.attempt_watermark === row.discussion_watermark;
        const attemptCount = sameAttempt ? row.attempt_count + 1 : 1;
        if (trigger !== 'manual') {
          if (sameAttempt && row.attempt_count >= config.agents.maxAutomaticAttempts) continue;
          if (sameAttempt && row.retry_after && row.retry_after > now) continue;
          const since = new Date(Date.now() - 60 * 60_000).toISOString();
          const recentRuns = Number((this.database.connection.prepare(`
            SELECT COUNT(*) AS total FROM agent_runs
            WHERE review_id=? AND task LIKE 'code_review:%' AND started_at>=?
          `).get(row.id, since) as { total: number }).total);
          if (recentRuns >= config.agents.maxRunsPerPullRequestPerHour) continue;
        }
        const changed = this.database.connection.prepare(`
          UPDATE review_queue SET claim_owner=?, claimed_at=?, status='agent_working',
            manual_requested_at=NULL, manual_provider=NULL, attempt_count=?,
            attempt_head_sha=head_sha, attempt_watermark=discussion_watermark,
            retry_after=NULL, updated_at=? WHERE id=? AND claim_owner IS NULL
        `).run(this.owner, now, attemptCount, now, row.id);
        if (!changed.changes) continue;
        this.database.connection.exec('COMMIT');
        return {
          reviewId: row.id,
          owner: this.owner,
          headSha: row.head_sha,
          discussionWatermark: row.discussion_watermark,
          trigger,
          ...(row.manual_provider ? { provider: row.manual_provider } : {}),
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

  private scheduleRetry(): void {
    const config = this.configSource();
    if (this.stopped || this.retryTimer || !config.agents.autoReview) return;
    const row = this.database.connection.prepare(`
      SELECT MIN(retry_after) AS retry_after FROM review_queue
      WHERE remote_state='OPEN' AND claim_owner IS NULL AND retry_after IS NOT NULL
        AND attempt_count < ?
    `).get(config.agents.maxAutomaticAttempts) as { retry_after: string | null };
    if (!row.retry_after) return;
    const delay = Math.max(0, new Date(row.retry_after).getTime() - Date.now());
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.pump();
    }, Math.min(delay, 2_147_000_000));
  }
}
