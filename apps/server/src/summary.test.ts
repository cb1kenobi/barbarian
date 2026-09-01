import { describe, expect, it } from 'vitest';
import { explainPullRequest, simplify, summarizePullRequest } from './summary.js';

describe('simplify', () => {
  it('removes conventional-commit cruft and keeps the first useful sentence', () => {
    expect(simplify('fix(storage): prevent stale handles', 'This stops readers from reusing a closed handle.\n\n## Details\nMore text.'))
      .toBe('prevent stale handles. This stops readers from reusing a closed handle.');
  });

  it('falls back to the cleaned title', () => {
    expect(simplify('chore: update docs', '')).toBe('update docs');
  });
});

describe('explainPullRequest', () => {
  it('separates the problem from the solution in plain language', () => {
    const summary = explainPullRequest('fix: keep counters correct', `
## Problem
Two workers can update the same counter at once. One update can disappear.

## Solution
The change reloads the latest value before saving. It also adds a test with two workers.
`);
    expect(summary).toBe('Problem: Two workers can update the same counter at once. One update can disappear.\n\nSolution: The change reloads the latest value before saving. It also adds a test with two workers.');
  });
});

describe('summarizePullRequest', () => {
  it('describes the change without repeating the PR title', () => {
    const summary = summarizePullRequest('fix: prevent stale handles', `
## Problem
Readers can retain a handle after its underlying resource has
closed. Reusing it can return stale data.

## Solution
The change invalidates cached handles during shutdown. A regression test covers the close-and-reopen path.
`);
    expect(summary).toBe('Readers can retain a handle after its underlying resource has closed. The change invalidates cached handles during shutdown. A regression test covers the close-and-reopen path.');
    expect(summary).not.toContain('prevent stale handles');
  });

  it('drops a body sentence that only echoes the title', () => {
    expect(summarizePullRequest(
      'Add retry support to uploads',
      'Add retry support to uploads. Failed chunks are retried without restarting the entire transfer.',
    )).toBe('Failed chunks are retried without restarting the entire transfer.');
  });

  it('uses an honest fallback instead of the title when the body is empty', () => {
    expect(summarizePullRequest('chore: update dependencies', '')).toBe('No additional description was provided.');
  });
});
