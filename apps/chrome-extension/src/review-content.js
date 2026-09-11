export function pullRequestSummary(review) {
  return review?.simple_summary?.trim()
    || 'Barbarian does not have a summary for this pull request yet.';
}

export function reviewRoundCount(review) {
  const count = Number(review?.review_round_count);
  return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
}
