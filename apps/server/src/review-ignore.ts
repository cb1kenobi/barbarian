import type { AgentRuntime } from './agent-runtime.js';
import type { BarbarianDatabase } from './database.js';

export function ignoreReview(
  database: BarbarianDatabase,
  runtime: AgentRuntime,
  reviewId: string,
): { found: boolean; cancelled: number } {
  const review = database.connection.prepare('SELECT id FROM review_queue WHERE id=?').get(reviewId);
  if (!review) return { found: false, cancelled: 0 };

  const runtimeKeys = database.connection.prepare(`
    SELECT DISTINCT runtime_key FROM agent_runs
    WHERE review_id=? AND status='running'
      AND (task LIKE 'code_review:%' OR task='address_feedback')
      AND runtime_key IS NOT NULL
  `).all(reviewId) as Array<{ runtime_key: string }>;
  const now = new Date().toISOString();
  database.connection.exec('BEGIN IMMEDIATE');
  try {
    database.connection.prepare(`
      UPDATE review_queue SET ignored_at=?,
        status=CASE WHEN status='agent_working' THEN 'unreviewed' ELSE status END,
        claim_owner=NULL, claimed_at=NULL, manual_requested_at=NULL, manual_provider=NULL,
        retry_after=NULL, last_agent_error=NULL,
        feedback_claim_owner=NULL, feedback_claimed_at=NULL, feedback_retry_after=NULL,
        feedback_last_error=NULL, feedback_needs_input=0, updated_at=?
      WHERE id=?
    `).run(now, now, reviewId);
    database.connection.prepare(`
      UPDATE agent_runs SET status='cancelled', finished_at=?, error='Pull request ignored', prompt=''
      WHERE review_id=? AND status='running'
        AND (task LIKE 'code_review:%' OR task='address_feedback')
    `).run(now, reviewId);
    database.connection.exec('COMMIT');
  } catch (error) {
    database.connection.exec('ROLLBACK');
    throw error;
  }

  const cancellationKeys = new Set([
    reviewId,
    `${reviewId}:feedback`,
    ...runtimeKeys.map((row) => row.runtime_key),
  ]);
  const cancelled = [...cancellationKeys].reduce((total, key) => (
    total + runtime.cancel(key, new Error('Pull request ignored'))
  ), 0);
  return { found: true, cancelled };
}
