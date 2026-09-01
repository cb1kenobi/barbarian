const keywords = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'create',
  'default', 'delete', 'do', 'drop', 'else', 'enum', 'export', 'extends', 'finally', 'for',
  'from', 'function', 'if', 'implements', 'import', 'in', 'insert', 'instanceof', 'interface',
  'into', 'let', 'new', 'of', 'private', 'protected', 'public', 'return', 'select', 'static',
  'switch', 'throw', 'try', 'type', 'typeof', 'union', 'update', 'using', 'var', 'where',
  'while', 'with', 'yield', 'and', 'or', 'not', 'def', 'elif', 'except', 'lambda', 'pass',
]);
const literals = new Set(['true', 'false', 'null', 'undefined', 'none', 'nil', 'nan', 'infinity']);

export function escapeMarkdownHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]);
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? value : null;
  } catch { return null; }
}

function renderInline(value) {
  const tokens = [];
  const stash = (html) => {
    const token = `\uE000${tokens.length}\uE001`;
    tokens.push(html);
    return token;
  };
  let source = String(value);
  source = source.replace(/`([^`\n]+)`/g, (_match, code) => stash(`<code>${escapeMarkdownHtml(code)}</code>`));
  source = source.replace(/\[([^\]]+)]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => {
    const href = safeUrl(url);
    return stash(href
      ? `<a href="${escapeMarkdownHtml(href)}" target="_blank" rel="noreferrer">${renderInline(label)}</a>`
      : escapeMarkdownHtml(label));
  });
  source = source.replace(/<((?:https?:\/\/|mailto:)[^ >]+)>/g, (_match, url) => {
    const href = safeUrl(url);
    return stash(href
      ? `<a href="${escapeMarkdownHtml(href)}" target="_blank" rel="noreferrer">${escapeMarkdownHtml(url)}</a>`
      : escapeMarkdownHtml(url));
  });
  let html = escapeMarkdownHtml(source)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replaceAll('\n', '<br>');
  tokens.forEach((token, index) => { html = html.replaceAll(`\uE000${index}\uE001`, token); });
  return html;
}

function tokenClass(token) {
  const lower = token.toLowerCase();
  if (/^(?:\/\*|\/\/|<!--|--|#)/.test(token)) return 'comment';
  if (/^["'`]/.test(token)) return 'string';
  if (/^\d/.test(token)) return 'number';
  if (keywords.has(lower)) return 'keyword';
  if (literals.has(lower)) return 'literal';
  return '';
}

export function highlightCode(value = '') {
  const code = String(value);
  const pattern = /(\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|\/\/[^\n]*|--[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let html = '';
  let cursor = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    html += escapeMarkdownHtml(code.slice(cursor, index));
    const kind = tokenClass(token);
    html += kind ? `<span class="tok-${kind}">${escapeMarkdownHtml(token)}</span>` : escapeMarkdownHtml(token);
    cursor = index + token.length;
  }
  return html + escapeMarkdownHtml(code.slice(cursor));
}

function cells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
}

function isBlockStart(lines, index) {
  const line = lines[index] || '';
  const next = lines[index + 1] || '';
  return /^\s*$|^\s*```|^\s{0,3}#{1,6}\s+|^\s*>\s?|^\s*[-+*]\s+|^\s*\d+[.)]\s+|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
    || (line.includes('|') && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(next));
}

export function renderMarkdown(value = '') {
  const lines = String(value).replaceAll('\r\n', '\n').split('\n');
  const output = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] || '';
    if (!line.trim()) { index += 1; continue; }

    const fence = /^\s*```([^\s`]*)\s*$/.exec(line);
    if (fence) {
      const language = (fence[1] || 'text').replace(/[^\w+-]/g, '') || 'text';
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] || '')) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      output.push(`<pre class="md-code"><code class="language-${language}">${highlightCode(code.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length || 1;
      output.push(`<h${level}>${renderInline(heading[2] || '')}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      output.push('<hr>'); index += 1; continue;
    }

    if (line.includes('|') && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(lines[index + 1] || '')) {
      const headers = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && (lines[index] || '').includes('|') && (lines[index] || '').trim()) rows.push(cells(lines[index++] || ''));
      output.push(`<div class="md-table-wrap"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }

    const list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[1] || '');
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (index < lines.length) {
        const item = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index] || '');
        if (!item || /^\d/.test(item[1] || '') !== ordered) break;
        const task = /^\[([ xX])]\s+(.+)$/.exec(item[2] || '');
        items.push(task
          ? `<li class="task"><input type="checkbox" disabled${task[1]?.toLowerCase() === 'x' ? ' checked' : ''}>${renderInline(task[2] || '')}</li>`
          : `<li>${renderInline(item[2] || '')}</li>`);
        index += 1;
      }
      output.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] || '')) quote.push((lines[index++] || '').replace(/^\s*>\s?/, ''));
      output.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`);
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] || '').trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++] || '');
    output.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }
  return output.join('');
}
