import { describe, expect, it } from 'vitest';
import { formatTimelineTime, renderTimeline } from './timeline.js';

describe('review timeline', () => {
  it('shows the completion verdict and retained agent output', () => {
    const html = renderTimeline([{
      created_at: '2026-01-02T04:05:00Z',
      label: 'Initial AI review completed — ready',
      outcome: { verdict: 'ready', findings: 0, summary: 'No blocking issues found.' },
      agents: [{
        provider: 'codex', model: 'gpt-review', effort: 'high', status: 'complete',
        output: 'Agent transcript', error: null,
      }],
    }]);
    expect(html).toContain('Initial AI review completed — ready');
    expect(html).toContain('<strong>Ready</strong>');
    expect(html).toContain('No blocking issues found.');
    expect(html).toContain('<pre>Agent transcript</pre>');
    expect(html).toContain('tabindex="0"');
  });

  it('escapes untrusted output and exposes failures', () => {
    const html = renderTimeline([{
      created_at: 'invalid', label: 'Review failed', outcome: null,
      agents: [{
        provider: 'codex', model: 'default', effort: 'CLI default', status: 'failed',
        output: '<script>bad()</script>', error: 'provider <failed>',
      }],
    }]);
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
    expect(html).toContain('provider &lt;failed&gt;');
    expect(html).not.toContain('<script>');
  });

  it('formats invalid timestamps without throwing', () => {
    expect(formatTimelineTime('not-a-date')).toBe('not-a-date');
  });
});
