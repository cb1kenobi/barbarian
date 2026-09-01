import { describe, expect, it } from 'vitest';
import { reviewActionIsVisible } from './review-events.js';

describe('Chrome extension review events', () => {
  it('waits until my approval is reflected on the current PR head', () => {
    const review = { head_sha: 'head', viewer_review_state: 'COMMENTED', viewer_review_sha: 'head' };
    expect(reviewActionIsVisible({ review }, 'approve')).toBe(false);
    expect(reviewActionIsVisible({ review: {
      ...review, viewer_review_state: 'APPROVED', viewer_review_sha: 'old-head',
    } }, 'approve')).toBe(false);
    expect(reviewActionIsVisible({ review: {
      ...review, viewer_review_state: 'APPROVED', viewer_review_sha: 'head',
    } }, 'approve')).toBe(true);
  });

  it('accepts the server display status as the canonical approval result', () => {
    expect(reviewActionIsVisible({ review: { display_status: 'approved' } }, 'approve')).toBe(true);
  });
});
