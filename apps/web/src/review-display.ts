export interface ReviewStatusSource {
  status?: unknown;
  display_status?: unknown;
}

const labels: Record<string, string> = {
  draft: 'Draft',
  unreviewed: 'Needs review',
  agent_working: 'Agent reviewing',
  agent_failed: 'Agent failed',
  issues_found: 'Issues found',
  awaiting_feedback: 'Waiting on author',
  ready_to_merge: 'Ready to merge',
  partially_reviewed: 'Partially reviewed',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed',
};

export const reviewStatusGuide = [
  { status: 'draft', description: 'The pull request is not ready for review; agent reviews are disabled.' },
  { status: 'unreviewed', description: 'No completed review exists for the current PR head.' },
  { status: 'agent_working', description: 'A Barbarian agent is actively reviewing the PR.' },
  { status: 'agent_failed', description: 'The last agent attempt failed and may be retried.' },
  { status: 'issues_found', description: 'The agent found unresolved blocking issues.' },
  { status: 'awaiting_feedback', description: 'Review feedback is waiting for an author response or fixes.' },
  { status: 'ready_to_merge', description: 'The agent found no blocking issues on the current head.' },
  { status: 'partially_reviewed', description: 'Another reviewer approved; your current-head approval is still pending.' },
  { status: 'approved', description: 'You approved the PR, and any newer commits passed a clean agent re-review.' },
  { status: 'merged', description: 'The pull request has been merged.' },
  { status: 'closed', description: 'The pull request was closed without merging.' },
] as const;

export function reviewDisplayStatus(review: ReviewStatusSource): string {
  if (typeof review.display_status === 'string' && review.display_status) return review.display_status;
  if (typeof review.status === 'string' && review.status) return review.status;
  return 'unreviewed';
}

export function countReviewsNeedingApproval(reviews: ReviewStatusSource[]): number {
  return reviews.filter((review) => !['approved', 'draft'].includes(reviewDisplayStatus(review))).length;
}

export function statusLabel(status: unknown): string {
  if (typeof status !== 'string' || !status) return 'Needs review';
  return labels[status] || status.replaceAll('_', ' ');
}

export function statusTone(status: unknown): string {
  if (status === 'agent_working') return 'working';
  if (status === 'issues_found' || status === 'awaiting_feedback' || status === 'agent_failed') return 'feedback';
  if (status === 'partially_reviewed') return 'partial';
  if (status === 'ready_to_merge' || status === 'approved') return 'ready';
  return 'quiet';
}
