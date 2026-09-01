import type { BarbarianDatabase } from './database.js';
import { fetchPullRequestReviewContext } from './github.js';
import {
  displayReviewStatus,
  viewerApprovedCurrentHead,
  viewerRequestedChangesCurrentHead,
} from './review-state.js';

export interface StoredReviewFinding {
  id: string;
  review_id: string;
  remote_id: number;
  author: string;
  body: string;
  summary: string;
  url: string;
  path: string | null;
  line: number | null;
  resolved: number | boolean;
  outdated: number | boolean;
  created_at: string;
  updated_at: string;
}

export interface ReviewAssessmentInput {
  status: string;
  remote_state: string;
  is_draft: number | boolean;
  review_decision: string | null;
  viewer_review_state: string | null;
  viewer_review_sha: string | null;
  other_approvals: number;
  findings_count: number;
  head_sha: string;
  last_reviewed_sha: string | null;
  discussion_watermark?: string;
  last_reviewed_watermark?: string | null;
}

export function buildReviewAssessment(review: ReviewAssessmentInput, findings: StoredReviewFinding[]) {
  const linkedOpen = findings.filter((finding) => !finding.resolved && !finding.outdated).length;
  const open = findings.length ? linkedOpen : review.findings_count;
  const resolved = findings.filter((finding) => Boolean(finding.resolved)).length;
  const outdated = findings.filter((finding) => !finding.resolved && Boolean(finding.outdated)).length;
  const total = Math.max(findings.length, review.findings_count);
  const stale = Boolean(
    review.last_reviewed_sha && review.last_reviewed_sha !== review.head_sha
    || review.last_reviewed_watermark !== undefined && review.last_reviewed_watermark !== null
      && (review.discussion_watermark || '') > review.last_reviewed_watermark,
  );

  const displayStatus = displayReviewStatus(review);
  let label = 'Needs Review';
  let tone = 'attention';
  if (review.remote_state === 'MERGED' || displayStatus === 'merged') { label = 'Merged'; tone = 'done'; }
  else if (review.remote_state === 'CLOSED' || displayStatus === 'closed') { label = 'Closed'; tone = 'quiet'; }
  else if (review.is_draft) { label = 'Draft'; tone = 'quiet'; }
  else if (displayStatus === 'agent_working') { label = 'AI Reviewing'; tone = 'working'; }
  else if (displayStatus === 'agent_failed') { label = 'Agent Failed'; tone = 'attention'; }
  else if (open > 0 || displayStatus === 'issues_found' || displayStatus === 'awaiting_feedback') { label = 'Needs Fixes'; tone = 'attention'; }
  else if (displayStatus === 'approved') { label = 'Approved'; tone = 'done'; }
  else if (displayStatus === 'partially_reviewed') { label = 'Partially Reviewed'; tone = 'working'; }
  else if (displayStatus === 'ready_to_merge') { label = 'Ready to Merge'; tone = 'done'; }

  let message = 'No AI review has been completed for this version yet.';
  if (review.status === 'agent_working') message = 'An AI reviewer is checking this pull request now.';
  else if (review.status === 'agent_failed') message = 'The AI reviewer failed. Barbarian will retry with backoff or you can start it manually.';
  else if (stale) message = 'New commits were pushed after the last AI review. It needs another pass.';
  else if (displayStatus === 'partially_reviewed') message = 'Another reviewer approved this pull request, but your approval is still pending.';
  else if (open > 0) message = `${open} of ${total} AI review ${total === 1 ? 'comment is' : 'comments are'} still open.`;
  else if (total > 0 && outdated > 0) {
    message = `No AI review comments still need action. ${resolved} resolved; ${outdated} became outdated.`;
  } else if (total > 0) message = `All ${total} AI review ${total === 1 ? 'comment is' : 'comments are'} resolved.`;
  else if (review.last_reviewed_sha) message = 'The latest AI review found no issues that still need attention.';

  return { label, tone, message, counts: { total, open, resolved, outdated }, stale };
}

export function storedReviewFindings(database: BarbarianDatabase, reviewId: string): StoredReviewFinding[] {
  return database.connection.prepare(`
    SELECT * FROM review_findings WHERE review_id=? ORDER BY resolved ASC, outdated ASC, created_at ASC
  `).all(reviewId) as unknown as StoredReviewFinding[];
}

export async function refreshReviewContext(database: BarbarianDatabase, reviewId: string): Promise<void> {
  const review = database.connection.prepare(`
    SELECT id, repository, number, status, last_reviewed_sha, discussion_watermark, last_reviewed_watermark,
      viewer_review_state, viewer_review_sha, other_approvals,
      attempt_head_sha, attempt_watermark
    FROM review_queue WHERE id=?
  `).get(reviewId) as {
    id: string;
    repository: string;
    number: number;
    status: string;
    last_reviewed_sha: string | null;
    discussion_watermark: string;
    last_reviewed_watermark: string | null;
    viewer_review_state: string | null;
    viewer_review_sha: string | null;
    other_approvals: number;
    attempt_head_sha: string | null;
    attempt_watermark: string | null;
  } | undefined;
  if (!review) throw new Error('Review not found');
  const remote = await fetchPullRequestReviewContext(review.repository, review.number);
  const openFindings = remote.findings.filter((finding) => !finding.resolved && !finding.outdated).length;
  const watermark = remote.discussionWatermark > review.discussion_watermark
    ? remote.discussionWatermark
    : review.discussion_watermark;
  const reviewedWatermark = review.last_reviewed_sha && review.last_reviewed_watermark === null
    ? watermark
    : review.last_reviewed_watermark;
  const stale = Boolean(
    review.last_reviewed_sha && review.last_reviewed_sha !== remote.headSha
    || reviewedWatermark !== null && watermark > reviewedWatermark,
  );
  const failedOnCurrentInput = review.status === 'agent_failed'
    && review.attempt_head_sha === remote.headSha
    && review.attempt_watermark === watermark;
  let status = review.status;
  const viewerReview = {
    head_sha: remote.headSha,
    viewer_review_state: remote.viewerReviewState,
    viewer_review_sha: remote.viewerReviewSha,
  };
  if (remote.state === 'MERGED') status = 'merged';
  else if (remote.state === 'CLOSED') status = 'closed';
  else if (viewerApprovedCurrentHead(viewerReview)) status = 'approved';
  else if (viewerRequestedChangesCurrentHead(viewerReview)) status = 'awaiting_feedback';
  else if (status === 'approved') status = 'unreviewed';
  else if (status !== 'agent_working' && !failedOnCurrentInput) {
    if (stale) status = 'unreviewed';
    else if (openFindings > 0) status = 'issues_found';
    else if (remote.findings.length > 0) status = 'ready_to_merge';
  }

  const now = new Date().toISOString();
  database.connection.exec('BEGIN IMMEDIATE');
  try {
    database.connection.prepare('DELETE FROM review_findings WHERE review_id=?').run(reviewId);
    const insert = database.connection.prepare(`
      INSERT INTO review_findings(
        id, review_id, remote_id, author, body, summary, url, path, line,
        resolved, outdated, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const finding of remote.findings) {
      insert.run(
        `${reviewId}:${finding.remoteId}`, reviewId, finding.remoteId, finding.author,
        finding.body, finding.summary, finding.url, finding.path, finding.line,
        finding.resolved ? 1 : 0, finding.outdated ? 1 : 0, finding.createdAt, now,
      );
    }
    database.connection.prepare(`
      UPDATE review_queue SET status=?, findings_count=?, review_decision=?, remote_state=?,
        viewer_review_state=?, viewer_review_sha=?, other_approvals=?, merged_at=?, review_paused=CASE
          WHEN head_sha<>? OR ?>discussion_watermark THEN 0 ELSE review_paused END,
        head_sha=?, discussion_watermark=?,
        last_reviewed_watermark=COALESCE(last_reviewed_watermark, ?), updated_at=? WHERE id=?
    `).run(
      status, openFindings, remote.reviewDecision, remote.state,
      remote.viewerReviewState, remote.viewerReviewSha, remote.otherApprovals, remote.mergedAt,
      remote.headSha, watermark, remote.headSha, watermark, reviewedWatermark, now, reviewId,
    );
    database.connection.exec('COMMIT');
  } catch (error) {
    database.connection.exec('ROLLBACK');
    throw error;
  }
}
