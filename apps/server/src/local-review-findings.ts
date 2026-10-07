import { createHash } from 'node:crypto';
import type { BarbarianDatabase } from './database.js';
import { summarizeReviewComment, type ReviewCommentDraft } from './github.js';

/** Called within the transaction that completes the claimed review. */
export function replaceLocalReviewFindings(
  database: BarbarianDatabase, reviewId: string, headSha: string,
  comments: ReviewCommentDraft[], author: string, now: string,
): void {
  database.connection.prepare('DELETE FROM local_review_findings WHERE review_id=?').run(reviewId);
  const insert = database.connection.prepare(`
    INSERT INTO local_review_findings(review_id, ordinal, head_sha, path, line, side, body, summary, author, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [ordinal, comment] of comments.entries()) {
    insert.run(reviewId, ordinal, headSha, comment.path, comment.line, comment.side,
      comment.body, summarizeReviewComment(comment.body), author, now);
  }
}

export function localReviewFindings(database: BarbarianDatabase, reviewId: string) {
  const rows = database.connection.prepare(`
    SELECT f.*, q.url, f.head_sha<>q.head_sha AS outdated
    FROM local_review_findings f JOIN review_queue q ON q.id=f.review_id
    WHERE f.review_id=? ORDER BY f.ordinal
  `).all(reviewId) as Array<{
    ordinal: number; review_id: string; path: string; line: number; side: string;
    body: string; summary: string; author: string; created_at: string; url: string; outdated: number;
  }>;
  return rows.map((row) => ({
    id: `local:${row.review_id}:${row.ordinal}`, review_id: row.review_id, remote_id: null,
    source: 'local' as const, author: row.author, body: row.body, summary: row.summary,
    path: row.path, line: row.line, resolved: false, outdated: Boolean(row.outdated),
    url: `${row.url}/files#diff-${createHash('sha256').update(row.path).digest('hex')}${row.side === 'LEFT' ? 'L' : 'R'}${row.line}`,
    created_at: row.created_at, updated_at: row.created_at,
  }));
}

export function currentLocalFindingCount(database: BarbarianDatabase, reviewId: string, headSha: string): number {
  return Number((database.connection.prepare(
    'SELECT COUNT(*) AS total FROM local_review_findings WHERE review_id=? AND head_sha=?',
  ).get(reviewId, headSha) as { total: number }).total);
}
