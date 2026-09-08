import { describe, expect, it } from 'vitest';
import { explainPullRequest, normalizeSummaryMarkup, simplify, summarizePullRequest } from './summary.js';

describe('normalizeSummaryMarkup', () => {
  it('preserves structure and safe inline code while removing HTML-only content', () => {
    const normalized = normalizeSummaryMarkup(`
<h2>Changes</h2><ul><li>Alpha</li><li><code>beta()</code></li></ul><form><button>Save</button></form>
<script>hidden()</script><style>.hidden { display: none }</style><!-- omitted -->
`);

    expect(normalized).toContain('## Changes');
    expect(normalized).toContain('- Alpha');
    expect(normalized).toContain('- `beta()`');
    expect(normalized).toContain('Save');
    expect(normalized).not.toContain('AlphaBeta');
    expect(normalized).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(normalized).not.toContain('hidden');
  });

  it('is total, bounded, idempotent, and unchanged for ordinary Markdown', () => {
    const markdown = '## Summary\n\nKeeps `inline_code` and [a link](https://example.test).';
    expect(normalizeSummaryMarkup(markdown)).toBe(markdown);
    expect(normalizeSummaryMarkup(normalizeSummaryMarkup('<p>Safe&nbsp;text</p>')))
      .toBe(normalizeSummaryMarkup('<p>Safe&nbsp;text</p>'));
    expect(() => normalizeSummaryMarkup('&#1114112; &#xD800; &#not-a-number;')).not.toThrow();

    for (const adversarial of [
      '<a "'.repeat(10_000),
      '&'.repeat(100_000),
      '<code>'.repeat(10_000),
      '<h6>'.repeat(25_000),
    ]) {
      expect(normalizeSummaryMarkup(adversarial).length).toBeLessThanOrEqual(100_000);
    }
  });

  it('preserves Markdown angle-bracket syntax without letting it hide known tags', () => {
    expect(normalizeSummaryMarkup('Keep if (a < b), Array<T>, <https://example.test>, and <API_KEY>; <strong>retain this</strong>.'))
      .toBe('Keep if (a < b), Array<T>, <https://example.test>, and <API_KEY>; retain this.');
    expect(normalizeSummaryMarkup('<!doctype html><p>Readable</p>')).toBe('\n\nReadable\n\n');
  });

  it('keeps later prose after malformed markup and protects Markdown code spans', () => {
    const normalized = normalizeSummaryMarkup('Use `<template>` here. <script>Keep the later migration steps. <!-- unfinished note');
    expect(normalized).toContain('`<template>`');
    expect(normalized).toContain('Keep the later migration steps.');
    expect(normalized).toContain('unfinished note');
  });

  it('does not pair prose tags with closing tags inside Markdown fences', () => {
    const normalized = normalizeSummaryMarkup(`Adds a <template> element to the shell.

## Details

The generated markup is:

\`\`\`html
<template id="sidebar">content</template>
\`\`\`

Everything else is unchanged.`);
    expect(normalized).toContain('## Details');
    expect(normalized).toContain('The generated markup is:');
    expect(normalized).toContain('Everything else is unchanged.');
  });

  it('still pairs discarded containers after bare or malformed angle text', () => {
    const normalized = normalizeSummaryMarkup('Ensure a < b first. <a href="unfinished then <style>.hidden { display: none }</style> Done.');
    expect(normalized).not.toContain('hidden');
    expect(normalized).toContain('Done.');

    const attributeCode = normalizeSummaryMarkup('Replace <button onclick="alert(`hi)"> now. <style>.secret{display:none}</style> See `docs`.');
    expect(attributeCode).not.toContain('secret');
    expect(attributeCode).toContain('See `docs`.');
  });

  it('drops a discarded container through a malformed closing tag', () => {
    expect(normalizeSummaryMarkup('Before.<script>hidden()</script')).toBe('Before.\n\n');
    const withLaterText = normalizeSummaryMarkup('Before.<script>hidden()</script After.');
    expect(withLaterText).not.toContain('hidden');
    expect(withLaterText).toContain('After.');
  });

  it('does not let unmatched backticks or oversized tags bypass normalization', () => {
    const unmatchedBacktick = normalizeSummaryMarkup('Before ` <script>hidden()</script> After.');
    expect(unmatchedBacktick).not.toContain('hidden');
    expect(unmatchedBacktick).toContain('After.');

    const oversizedTag = normalizeSummaryMarkup(`<script data-padding="${'x'.repeat(1_100)}">hidden()</script> After.`);
    expect(oversizedTag).not.toContain('hidden');
    expect(oversizedTag).not.toMatch(/<\/?script/i);
    expect(oversizedTag).toContain('After.');

    const oversizedTagWithAngle = normalizeSummaryMarkup(`<script data-padding="${'x'.repeat(1_100)}">if (a < b) hidden()</script> After.`);
    expect(oversizedTagWithAngle).not.toContain('hidden');
    expect(oversizedTagWithAngle).toContain('After.');

    const oversizedLink = normalizeSummaryMarkup(`<a href="${'x'.repeat(1_100)}">Dashboard</a> After link.`);
    expect(oversizedLink).not.toContain('href');
    expect(oversizedLink).not.toContain('xxx');
    expect(oversizedLink).toContain('After link.');

    expect(normalizeSummaryMarkup('A <p without closing it and writes a long paragraph.'))
      .toBe('A <p without closing it and writes a long paragraph.');
  });

  it('renders deliberately escaped tags as inline code', () => {
    const normalized = normalizeSummaryMarkup('Use &lt;template&gt; or &#60;slot&#62; in the layout.');
    expect(normalized).toBe('Use `<template>` or `<slot>` in the layout.');
    expect(normalizeSummaryMarkup(normalized)).toBe(normalized);
    expect(normalizeSummaryMarkup('Show &lt;script> literally.')).toBe('Show `<script>` literally.');
  });

  it('restores escaped comparisons without fabricating a code span', () => {
    expect(normalizeSummaryMarkup('Requires Node &lt; 18 and npm &gt; 9.'))
      .toBe('Requires Node < 18 and npm > 9.');
  });

  it('removes literal private-use sentinel characters from input', () => {
    expect(normalizeSummaryMarkup(`Keep ${'\ue000'}script${'\ue001'} readable.`)).toBe('Keep script readable.');
  });
});

describe('simplify', () => {
  it('removes conventional-commit cruft and keeps the first useful sentence', () => {
    expect(simplify('fix(storage): prevent stale handles', 'This stops readers from reusing a closed handle.\n\n## Details\nMore text.'))
      .toBe('prevent stale handles. This stops readers from reusing a closed handle.');
  });

  it('falls back to the cleaned title', () => {
    expect(simplify('chore: update docs', '')).toBe('update docs');
  });

  it('does not leak converted HTML list markers', () => {
    expect(simplify('fix: preserve recovery data', '<ul><li>Recovery preserves audit entries before retrying.</li></ul>'))
      .toBe('preserve recovery data. Recovery preserves audit entries before retrying.');
    expect(simplify('fix: save settings', '<p>Steps to reproduce</p><ul><li>Open the settings panel and click save.</li></ul>'))
      .toBe('save settings. Open the settings panel and click save.');
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

  it('bounds generated descriptions while preserving ordinary complete summaries', () => {
    const summary = summarizePullRequest('fix: generated description', `## Summary\n\n${'word '.repeat(2_000)}.`);
    expect(summary.length).toBeLessThanOrEqual(2_400);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('turns Dependabot HTML into a short readable dependency summary', () => {
    const summary = summarizePullRequest('chore(deps-dev): bump tsdown', `
Bumps the minor-development group with 1 update: [tsdown](https://github.com/rolldown/tsdown).

Updates \`tsdown\` from 0.22.14 to 0.23.0
<details>
<summary>Release notes</summary>
<blockquote><h3>🧭 Migration Guide</h3>
<p>Most users can upgrade directly. Before upgrading, run one final build with <code>tsdown@0.22.14</code> and resolve all deprecation warnings.</p>
<ul><li><code>bundle: false</code> → <code>unbundle: true</code></li><li>Node.js 25 is no longer supported</li></ul>
<script>ignoreThis()</script><!-- raw HTML omitted -->
</blockquote>
</details>
`);

    expect(summary).toBe('Bumps the minor-development group with 1 update: tsdown. Most users can upgrade directly. Before upgrading, run one final build with `tsdown@0.22.14` and resolve all deprecation warnings.');
    expect(summary).not.toMatch(/<\/?[a-z][^>]*>/i);
    expect(summary).not.toContain('ignoreThis');
  });
});
