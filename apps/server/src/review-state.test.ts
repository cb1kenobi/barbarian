import { describe, expect, it } from 'vitest';
import { completedReviewStatus, displayReviewStatus, newCommitsSinceReview, reviewPriorityScore } from './review-state.js';

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

  it('keeps a locally carried approval after a clean follow-up review', () => {
    expect(displayReviewStatus({
      ...base, status: 'approved', viewer_review_state: 'APPROVED', viewer_review_sha: 'old',
    })).toBe('approved');
    expect(displayReviewStatus({
      ...base, status: 'unreviewed', viewer_review_state: 'APPROVED', viewer_review_sha: 'old',
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

  it('carries approval only across a clean agent result', () => {
    expect(completedReviewStatus(0, true)).toBe('approved');
    expect(completedReviewStatus(0, false)).toBe('ready_to_merge');
    expect(completedReviewStatus(1, true)).toBe('issues_found');
  });

  it('counts commits added after the last agent checkpoint', () => {
    expect(newCommitsSinceReview({
      head_sha: 'new', last_reviewed_sha: 'old', commit_count: 7, last_reviewed_commit_count: 4,
    })).toBe(3);
    expect(newCommitsSinceReview({
      head_sha: 'same', last_reviewed_sha: 'same', commit_count: 7, last_reviewed_commit_count: 7,
    })).toBe(0);
    expect(newCommitsSinceReview({
      head_sha: 'new', last_reviewed_sha: 'old', commit_count: 4, last_reviewed_commit_count: null,
    })).toBe(1);
  });
});
