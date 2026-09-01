export function pullRequestSummary(review) {
  return review?.simple_summary?.trim()
    || 'Barbarian does not have a summary for this pull request yet.';
}
