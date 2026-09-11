import { describe, expect, it } from 'vitest';
import { pullRequestSummary, reviewRoundCount } from './review-content.js';

describe('Chrome extension review content', () => {
  it('uses the PR summary instead of the agent findings summary', () => {
    expect(pullRequestSummary({
      simple_summary: 'This PR prevents duplicate review comments.',
      plain_summary: 'The review found two blocking issues.',
    })).toBe('This PR prevents duplicate review comments.');
  });

  it('provides a clear fallback when no PR summary is available', () => {
    expect(pullRequestSummary({ simple_summary: '' }))
      .toBe('Barbarian does not have a summary for this pull request yet.');
  });

  it('normalizes the AI review round count for display', () => {
    expect(reviewRoundCount({ review_round_count: 3 })).toBe(3);
    expect(reviewRoundCount({ review_round_count: undefined })).toBe(0);
    expect(reviewRoundCount({ review_round_count: -1 })).toBe(0);
  });
});
