import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('chat markdown rendering', () => {
  it('renders common markdown and highlights fenced code', () => {
    const html = renderMarkdown('**Result**\n\n```js\nconst answer = true;\n```');
    expect(html).toContain('<strong>Result</strong>');
    expect(html).toContain('class="language-js"');
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-literal">true</span>');
  });

  it('escapes HTML and rejects unsafe links', () => {
    const html = renderMarkdown('<script>alert(1)</script> [click](javascript:alert(1))');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('javascript:');
  });

  it('renders lists, tables, quotes, and safe links', () => {
    const html = renderMarkdown('- one\n- two\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> [Docs](https://example.com)');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('href="https://example.com"');
  });

  it('preserves underscores and styles inline identifiers as code', () => {
    const html = renderMarkdown('Calls `delete_audit_logs_before` from `ResourceBridge.ts`.');
    expect(html).toContain('<code>delete_audit_logs_before</code>');
    expect(html).toContain('<code>ResourceBridge.ts</code>');
  });
  it('renders the review priority badge as an image, including linked badges', () => {
    const badge = '![medium](https://www.gstatic.com/codereviewagent/medium-priority.svg)';
    const html = renderMarkdown(badge);
    expect(html).toContain('<img src="https://www.gstatic.com/codereviewagent/medium-priority.svg" alt="medium"');
    expect(html).not.toContain('!<a');
    expect(html).toContain('referrerpolicy="no-referrer"');
    const linked = renderMarkdown(`[${badge}](https://example.com/review)`);
    expect(linked).toContain('rel="noreferrer"><img');
    expect(linked).not.toMatch(/[\uE000\uE001]/);
  });

  it('escapes image attributes, rejects unsafe image sources, and preserves code', () => {
    expect(renderMarkdown('![image](javascript:alert)')).not.toContain('<img');
    expect(renderMarkdown('![image](mailto:person@example.com)')).not.toContain('<img');
    expect(renderMarkdown('![" onerror="bad](https://example.com/image.png)'))
      .toContain('alt="&quot; onerror=&quot;bad"');
    expect(renderMarkdown('`![medium](https://example.com/badge.svg)`')).not.toContain('<img');
  });

});
