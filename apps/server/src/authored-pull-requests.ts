import type { BarbarianDatabase } from './database.js';
import { authenticatedGithubLogin } from './github-identity.js';

export interface AuthoredPullRequestRow extends Record<string, unknown> {
  approved: boolean;
  has_new_feedback: boolean;
  has_review_activity: boolean;
  needs_input: boolean;
}

export function openAuthoredPullRequests(
  database: BarbarianDatabase,
  login: string,
): AuthoredPullRequestRow[] {
  const viewer = authenticatedGithubLogin(database, login);
  if (!viewer) return [];

  const rows = database.connection.prepare(`
    SELECT review_queue.*,
      CASE WHEN review_decision='APPROVED' THEN 1 ELSE 0 END AS approved,
      CASE WHEN feedback_needs_input=1
        OR status='issues_found'
        OR (review_decision='CHANGES_REQUESTED' AND (
          discussion_watermark=''
          OR discussion_watermark>COALESCE(last_feedback_handled_watermark, '')
        ))
        OR EXISTS (
          SELECT 1 FROM review_findings
          WHERE review_findings.review_id=review_queue.id
            AND review_findings.resolved=0 AND review_findings.outdated=0
        )
        OR discussion_watermark>COALESCE(author_seen_watermark, '')
        THEN 1 ELSE 0 END AS has_new_feedback,
      CASE WHEN review_decision IN ('APPROVED', 'CHANGES_REQUESTED')
        OR discussion_watermark<>''
        OR COALESCE(last_feedback_handled_watermark, '')<>''
        OR EXISTS (
          SELECT 1 FROM review_findings
          WHERE review_findings.review_id=review_queue.id
        )
        THEN 1 ELSE 0 END AS has_review_activity
    FROM review_queue
    WHERE remote_state='OPEN' AND is_draft=0 AND lower(author)=lower(?)
    ORDER BY updated_at DESC
  `).all(viewer) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    ...row,
    approved: Boolean(row.approved),
    has_new_feedback: Boolean(row.has_new_feedback),
    has_review_activity: Boolean(row.has_review_activity),
    needs_input: Boolean(row.feedback_needs_input),
  })) as AuthoredPullRequestRow[];
}
