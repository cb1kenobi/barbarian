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

  it('preserves inline code identifiers and complete long sentences', () => {
    const detail = 'x'.repeat(340);
    const summary = summarizePullRequest('fix: preserve audit-log results', `
## Summary
The \`delete_audit_logs_before\` operation now returns the value computed by \`dataLayer/harperBridge/ResourceBridge.ts\` after validating ${detail}.
`);
    expect(summary).toContain('`delete_audit_logs_before`');
    expect(summary).toContain('`dataLayer/harperBridge/ResourceBridge.ts`');
    expect(summary).toContain(detail);
    expect(summary).not.toContain('…');
  });

  it('keeps multiple changes from a single summary section', () => {
    const summary = summarizePullRequest('fix: two independent regressions', `
## Summary

1. The \`delete_audit_logs_before\` operation now returns its file count. Callers can distinguish a successful purge from a no-op.

2. The \`deleteHistory\` scan now skips symbol keys. Purges no longer produce misleading corruption errors.
`);
    expect(summary).toContain('`delete_audit_logs_before`');
    expect(summary).toContain('`deleteHistory`');
  });
});
