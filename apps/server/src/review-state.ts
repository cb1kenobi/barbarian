export interface ReviewStateInput {
  status: string;
  head_sha: string;
  viewer_review_state: string | null;
  viewer_review_sha: string | null;
  other_approvals: number;
}

export function viewerApprovedCurrentHead(review: Pick<ReviewStateInput,
  'head_sha' | 'viewer_review_state' | 'viewer_review_sha'>): boolean {
  return review.viewer_review_state === 'APPROVED' && review.viewer_review_sha === review.head_sha;
}

export function viewerRequestedChangesCurrentHead(review: Pick<ReviewStateInput,
  'head_sha' | 'viewer_review_state' | 'viewer_review_sha'>): boolean {
  return review.viewer_review_state === 'CHANGES_REQUESTED' && review.viewer_review_sha === review.head_sha;
}

export function displayReviewStatus(review: ReviewStateInput): string {
  if (review.status === 'merged' || review.status === 'closed') return review.status;
  if (viewerApprovedCurrentHead(review)) return 'approved';
  if (['agent_working', 'agent_failed', 'issues_found', 'awaiting_feedback'].includes(review.status)) {
    return review.status;
  }
  if (review.other_approvals > 0) return 'partially_reviewed';
  return review.status === 'approved' ? 'unreviewed' : review.status;
}

export function reviewPriorityScore(review: ReviewStateInput, repositoryPriority: number): number {
  const state = displayReviewStatus(review);
  const stateWeight = ({
    ready_to_merge: 6_000,
    unreviewed: 5_800,
    partially_reviewed: 5_600,
    agent_failed: 5_000,
    agent_working: 4_000,
    awaiting_feedback: 1_500,
    issues_found: 1_000,
    approved: 0,
  } as Record<string, number>)[state] ?? 3_000;
  return stateWeight + repositoryPriority;
}
