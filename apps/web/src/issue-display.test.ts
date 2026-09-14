import { describe, expect, it } from 'vitest';
import { issueProgress } from './issue-display';

const base = {
  in_progress_source: 'pull_request',
  in_progress_pr: 'https://github.com/Acme/storage/pull/99',
  in_progress_pr_draft: false,
  in_progress_branch: null,
  fixed_by: null,
  duplicate_of: null,
};

describe('issueProgress', () => {
  it('marks a linked draft immediately after the pull request number', () => {
    expect(issueProgress({ ...base, in_progress_pr_draft: true })).toBe('In progress · PR #99 (draft)');
  });

  it('does not mark a ready pull request as a draft', () => {
    expect(issueProgress(base)).toBe('In progress · PR #99');
  });
});
