import { describe, expect, it } from 'vitest';
import { renderReviewRounds } from './review-findings.js';

describe('review round history', () => {
  it('renders newest and older rounds with full finding bodies and delivery details', () => {
    const html = renderReviewRounds([
      { findings: 1, status: 'complete', provider: 'codex', model: 'model', head_sha: '1234567890', delivery: 'Pending human review', comments: [{ summary: 'Check the guard', body: '**Full explanation**', path: 'src/example.js', line: 42, url: 'https://github.com/owner/repo/pull/1/files' }] },
      { findings: 0, status: 'complete', provider: 'codex', outdated: true, summary: 'Clean round', comments: [] },
    ]);
    expect(html).toContain('Round 2 · 1 issue found');
    expect(html).toContain('Round 1 · No issues found · Earlier commit');
    expect(html.match(/class="review-round" open/g)).toHaveLength(1);
    expect(html).toContain('12345678');
    expect(html).toContain('Pending human review');
    expect(html).toContain('src/example.js:42');
    expect(html).toContain('<strong>Full explanation</strong>');
  });

  it('distinguishes missing older results and failures from clean rounds and escapes text', () => {
    const html = renderReviewRounds([
      { findings: null, status: 'complete', provider: 'codex', comments: [] },
      { findings: null, status: 'failed', error: '<script>failure</script>', comments: [] },
    ]);
    expect(html).toContain('No result was retained for this older round.');
    expect(html).toContain('Round 1 · failed');
    expect(html).toContain('&lt;script&gt;failure&lt;/script&gt;');
    expect(html).not.toContain('No issues found');
    expect(renderReviewRounds()).toBe('');
  });
});
