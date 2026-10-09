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

  it('renders collapsible references and markdown inside them', () => {
    const html = renderMarkdown('Finding\n<details>\n<summary>References</summary>\n\n1. Guard `afterEach` cleanup.\n</details>\nFollowing paragraph');
    expect(html).toBe('<p>Finding</p><details><summary>References</summary><ol><li>Guard <code>afterEach</code> cleanup.</li></ol></details><p>Following paragraph</p>');
  });

  it('renders flattened Dependabot release notes as HTML', () => {
    const html = renderMarkdown('Bumps oxfmt. <details> <summary>Release notes</summary> <p><em>Sourced from <a href="https://github.com/oxc-project/oxc/releases">oxfmt releases</a>.</em></p> <blockquote> <h2>oxfmt v0.72.0</h2> <h3>Breaking changes</h3> <ul> <li>Format <code>parser:markdown</code> files (<a href="https://example.com/27256">#27256</a>)</li> </ul> </blockquote> </details>');
    expect(html).toContain('<details> <summary>Release notes</summary>');
    expect(html).toContain('<p><em>Sourced from <a href="https://github.com/oxc-project/oxc/releases" target="_blank" rel="noreferrer">');
    expect(html).toContain('<blockquote> <h2>oxfmt v0.72.0</h2>');
    expect(html).toContain('<ul> <li>Format <code>parser:markdown</code>');
    expect(html).not.toContain('&lt;');
    expect(html).not.toMatch(/[\uE000\uE001]/);
  });

  it('renders HTML blocks across blank lines and balances truncated summaries', () => {
    expect(renderMarkdown('<blockquote>\n<h2>Release</h2>\n\n<ul>\n<li>First</li>\n\n<li>Second</li>\n</ul>\n</blockquote>\nAfter'))
      .toContain('</ul>\n</blockquote><p>After</p>');
    expect(renderMarkdown('Update <details><summary>Notes</summary><ul><li>Truncated…'))
      .toBe('Update <details><summary>Notes</summary><ul><li>Truncated…</li></ul></details>');
    expect(renderMarkdown('<p>Safe</p></div></section></details>')).not.toContain('</section>');
    expect(renderMarkdown('<p>Safe</p></details>')).toContain('&lt;/details&gt;');
  });

  it('supports inline HTML and entities without interpreting HTML code examples', () => {
    expect(renderMarkdown('Use <strong>safe</strong> <em>HTML</em> &amp; <code>**literal** &lt;tag&gt;</code>.'))
      .toBe('<p>Use <strong>safe</strong> <em>HTML</em> &amp; <code>**literal** &lt;tag&gt;</code>.</p>');
    expect(renderMarkdown('<pre>const value = "&lt;script&gt;";\n**literal**</pre>'))
      .toBe('<pre>const value = &quot;&lt;script&gt;&quot;;\n**literal**</pre>');
    expect(renderMarkdown('`<code>literal</code>`')).toBe('<p><code>&lt;code&gt;literal&lt;/code&gt;</code></p>');
  });

  it('rejects executable HTML, attributes, and encoded unsafe URLs', () => {
    const html = renderMarkdown('<p onclick="alert(1)">Text</p> <a href="javascript:alert(1)">bad</a> <a href="javascript&#58;alert(1)">encoded</a> <a href="https://example.com" onclick="alert(1)">event</a> <iframe src="https://example.com"></iframe> <svg onload="alert(1)"></svg>');
    expect(html).not.toContain('<p onclick');
    expect(html).not.toContain('<a href="javascript');
    expect(html).not.toContain('<a href="https://example.com" onclick');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<svg');
    expect(renderMarkdown('<a href="https://example.com/?a=1&amp;b=2">query</a>'))
      .toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(renderMarkdown('<a href="https://example.com/?q=&quot; onclick=&quot;alert(1)">quoted</a>'))
      .toContain('href="https://example.com/?q=&quot; onclick=&quot;alert(1)" target=');
  });

  it('keeps user text from duplicating internal HTML tokens', () => {
    const html = renderMarkdown('<details></details>\uE0001\uE001');
    expect(html).toBe('<details></details>\uE0001\uE001');
    expect(renderMarkdown('<details></details>\uE000\uE0001\uE001'))
      .toBe('<details></details>\uE000\uE0001\uE001');
  });

  it('balances nested and unclosed details without closing an outside container', () => {
    expect(renderMarkdown('<details open>\n<summary>Outer</summary>\n<details>\n<summary>Inner</summary>\nText\n</details>'))
      .toBe('<details open><summary>Outer</summary><details><summary>Inner</summary><p>Text</p></details></details>');
    expect(renderMarkdown('</details>')).toBe('<p>&lt;/details&gt;</p>');
  });

  it('keeps HTML in code literal and rejects attributes and scripts in disclosures', () => {
    expect(renderMarkdown('```html\n<details>\n<summary>References</summary>\n</details>\n```'))
      .not.toContain('<details>');
    expect(renderMarkdown('`<details>`')).toBe('<p><code>&lt;details&gt;</code></p>');
    expect(renderMarkdown('<details ontoggle="alert(1)">')).not.toContain('<details');
    const html = renderMarkdown('<details>\n<summary><img src=x onerror=alert(1)></summary>\n<script>alert(1)</script>\n</details>');
    expect(html).toContain('<summary>&lt;img');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
  });

});
