import type { BarbarianDatabase } from './database.js';

export interface AuthoredPullRequestRow extends Record<string, unknown> {
  approved: boolean;
  has_new_feedback: boolean;
}

/**
 * Returns open, non-draft PRs authored by the configured user that either have
 * actionable feedback or are cleanly approved and ready for the author to merge.
 */
export function authoredPullRequestsNeedingAttention(
  database: BarbarianDatabase,
  login: string,
): AuthoredPullRequestRow[] {
  if (!login.trim()) return [];

  const rows = database.connection.prepare(`
    SELECT review_queue.*,
      CASE WHEN review_decision='APPROVED' THEN 1 ELSE 0 END AS approved,
      CASE WHEN status='issues_found'
        OR review_decision='CHANGES_REQUESTED'
        OR EXISTS (
          SELECT 1 FROM review_findings
          WHERE review_findings.review_id=review_queue.id
            AND review_findings.resolved=0 AND review_findings.outdated=0
        )
        OR discussion_watermark>COALESCE(last_reviewed_watermark, '')
        THEN 1 ELSE 0 END AS has_new_feedback
    FROM review_queue
    WHERE remote_state='OPEN' AND is_draft=0 AND lower(author)=lower(?)
      AND (
        review_decision='APPROVED'
        OR status='issues_found'
        OR review_decision='CHANGES_REQUESTED'
        OR EXISTS (
          SELECT 1 FROM review_findings
          WHERE review_findings.review_id=review_queue.id
            AND review_findings.resolved=0 AND review_findings.outdated=0
        )
        OR discussion_watermark>COALESCE(last_reviewed_watermark, '')
      )
    ORDER BY updated_at DESC
  `).all(login) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...row,
    approved: Boolean(row.approved),
    has_new_feedback: Boolean(row.has_new_feedback),
  })) as AuthoredPullRequestRow[];
}
