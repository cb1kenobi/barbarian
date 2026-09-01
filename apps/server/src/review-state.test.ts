import { describe, expect, it } from 'vitest';
import { displayReviewStatus, reviewPriorityScore } from './review-state.js';

const base = {
  status: 'unreviewed', head_sha: 'current', viewer_review_state: null,
  viewer_review_sha: null, other_approvals: 0,
};

describe('review state presentation', () => {
  it('distinguishes another reviewer approval from the viewer approval', () => {
    expect(displayReviewStatus({ ...base, other_approvals: 1 })).toBe('partially_reviewed');
    expect(displayReviewStatus({
      ...base, status: 'approved', viewer_review_state: 'APPROVED', viewer_review_sha: 'current',
    })).toBe('approved');
  });

  it('does not keep approval after the pull request head changes', () => {
    expect(displayReviewStatus({
      ...base, status: 'approved', viewer_review_state: 'APPROVED', viewer_review_sha: 'old',
    })).toBe('unreviewed');
  });

  it('ranks actionable reviews above unresolved work and viewer-approved PRs', () => {
    const ready = reviewPriorityScore({ ...base, status: 'ready_to_merge' }, 10);
    const unresolved = reviewPriorityScore({ ...base, status: 'issues_found' }, 100);
    const approved = reviewPriorityScore({
      ...base, status: 'approved', viewer_review_state: 'APPROVED', viewer_review_sha: 'current',
    }, 100);
    expect(ready).toBeGreaterThan(unresolved);
    expect(unresolved).toBeGreaterThan(approved);
  });
});
