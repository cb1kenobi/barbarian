import { describe, expect, it } from 'vitest';
import { explainPullRequest, simplify } from './summary.js';

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
