import { createHash } from 'node:crypto';
import type { BarbarianDatabase } from './database.js';
import { parseReviewResult } from './agents.js';
import { newReviewComments } from './review-comments.js';
import { summarizeReviewComment } from './github.js';

/** Read durable agent output so earlier rounds (including clean rounds) remain visible. */
export function storedReviewRounds(database: BarbarianDatabase, reviewId: string) {
  const runs = database.connection.prepare(`
    SELECT id, owner, provider, model, effort, status, finished_at, reviewed_head_sha, output, error
    FROM agent_runs WHERE review_id=? AND task LIKE 'code_review:%' AND status IN ('complete', 'failed', 'cancelled')
    ORDER BY id ASC
  `).all(reviewId) as Array<{
    id: number; owner: string | null; provider: string; model: string; effort: string;
    status: string; finished_at: string; reviewed_head_sha: string | null; output: string; error: string | null;
  }>;
  const review = database.connection.prepare('SELECT url, head_sha FROM review_queue WHERE id=?').get(reviewId) as
    { url: string; head_sha: string } | undefined;
  const grouped = new Map<string, typeof runs>();
  for (const run of runs) {
    const key = run.owner || `run:${run.id}`;
    const group = grouped.get(key) || [];
    group.push(run);
    grouped.set(key, group);
  }
  const deliveries = new Map<string, { label: string; error: string | null }>();
  const events = database.connection.prepare(`
    SELECT kind, payload_json FROM activity_events WHERE subject_id=?
      AND kind IN ('agent_review_completed', 'agent_review_failed') ORDER BY id
  `).all(reviewId) as Array<{ kind: string; payload_json: string }>;
  for (const event of events) {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    if (typeof payload.owner !== 'string') continue;
    deliveries.set(payload.owner, {
      label: event.kind === 'agent_review_failed' ? 'Delivery failed'
        : payload.savedAsDraft ? 'Queued for human review' : payload.publishedReview ? 'Published to GitHub' : 'Saved in Findings',
      error: event.kind === 'agent_review_failed' && typeof payload.error === 'string' ? payload.error : null,
    });
  }
  return [...grouped.values()].reverse().map((group) => {
    const completed = group.filter((run) => run.status === 'complete');
    const run = completed.at(-1) || group.at(-1)!;
    const results = completed.flatMap((candidate) => {
      try { return [parseReviewResult(candidate.output)]; } catch { return []; }
    });
    const comments = newReviewComments({ inlineComments: [] }, results.flatMap((result) => result.comments));
    const summary = results.length ? [...new Set(results.map((result) => result.summary))].join('\n\n')
      : completed.map((candidate) => candidate.output).join('\n\n');
    return {
      id: run.id,
      provider: [...new Set((completed.length ? completed : [run]).map((candidate) => candidate.provider))].join(', '),
      model: [...new Set(completed.map((candidate) => candidate.model).filter(Boolean))].join(', '),
      effort: [...new Set(completed.map((candidate) => candidate.effort).filter(Boolean))].join(', '),
      completed_at: run.finished_at, head_sha: run.reviewed_head_sha,
      outdated: Boolean(run.reviewed_head_sha && review && run.reviewed_head_sha !== review.head_sha),
      status: run.status, summary,
      delivery: results.length && run.owner ? deliveries.get(run.owner)?.label || '' : '',
      error: run.error || (run.owner ? deliveries.get(run.owner)?.error : null) || null,
      findings: results.length ? comments.length : null,
      comments: comments.map((comment) => ({
        ...comment, summary: summarizeReviewComment(comment.body),
        url: `${review?.url}/files/${run.reviewed_head_sha || ''}#diff-${createHash('sha256').update(comment.path).digest('hex')}${comment.side === 'LEFT' ? 'L' : 'R'}${comment.line}`,
      })),
    };
  });
}
