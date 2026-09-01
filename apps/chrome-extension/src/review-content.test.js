import { describe, expect, it } from 'vitest';
import { pullRequestSummary } from './review-content.js';

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
});
