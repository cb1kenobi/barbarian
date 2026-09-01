export function reviewActionIsVisible(context, reviewAction) {
  const review = context?.review;
  if (!review) return false;
  if (reviewAction === 'approve') {
    return review.display_status === 'approved'
      || review.viewer_review_state === 'APPROVED' && review.viewer_review_sha === review.head_sha;
  }
  if (reviewAction === 'request_changes') return review.viewer_review_state === 'CHANGES_REQUESTED';
  return true;
}
