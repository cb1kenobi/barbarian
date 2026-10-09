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

const htmlTags = new Set(['a', 'b', 'blockquote', 'br', 'code', 'del', 'details', 'em',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'kbd', 'li', 'ol', 'p', 'pre',
  's', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
const htmlBlocks = new Set(['blockquote', 'details', 'h1', 'h2', 'h3', 'h4', 'h5',
  'h6', 'hr', 'li', 'ol', 'p', 'pre', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul']);
const voidTags = new Set(['br', 'hr']);
const htmlTagPattern = /<\/?[a-z][a-z0-9]*(?:\s+[^<>]*?)?\s*\/?\s*>/gi;

function safeHtmlTag(value) {
  const match = /^<(\/)?([a-z][a-z0-9]*)([\s\S]*?)>$/i.exec(value);
  if (!match) return null;
  const name = match[2].toLowerCase();
  if (!htmlTags.has(name)) return null;
  const closing = Boolean(match[1]);
  const attributes = match[3].trim();
  if (closing) return !attributes && !voidTags.has(name) ? { name, closing, html: `</${name}>` } : null;
  let html = `<${name}>`;
  if (name === 'details' && /^open$/i.test(attributes)) html = '<details open>';
  else if (name === 'a' && attributes) {
    const href = /^href\s*=\s*(?:"([^"]*)"|'([^']*)')$/i.exec(attributes);
    if (!href) return null;
    const url = href[1] ?? href[2];
    html = safeUrl(url) ? `<a href="${escapeHtmlText(url)}" target="_blank" rel="noreferrer">` : '<a>';
  } else if (attributes && !(voidTags.has(name) && attributes === '/')) return null;
  return { name, closing, html };
}

function escapeHtmlText(value) {
  return escapeMarkdownHtml(value).replace(/&amp;((?:#\d+|#x[\da-f]+|[a-z][a-z\d]+);)/gi, '&$1');
}

function updateHtmlStack(stack, tag) {
  const literal = stack.at(-1);
  if ((literal === 'code' || literal === 'pre') && !(tag.closing && tag.name === literal)) return '';
  if (!tag.closing) {
    if (!voidTags.has(tag.name)) stack.push(tag.name);
    return tag.html;
  }
  const index = stack.lastIndexOf(tag.name);
  if (index < 0) return escapeMarkdownHtml(tag.html);
  return stack.splice(index).reverse().map((name) => `</${name}>`).join('');
}

function renderInline(value, lineBreaks = true) {
  const tokens = [];
  let source = String(value);
  let tokenPrefix = '\uE000';
  while (source.includes(tokenPrefix)) tokenPrefix += '\uE000';
  const stash = (html) => {
    const token = `${tokenPrefix}${tokens.length}\uE001`;
    tokens.push(html);
    return token;
  };
  let hasHtml = false;
  source = source.replace(/`([^`\n]+)`|<(code|pre)>([\s\S]*?)(?:<\/\2>|$)/gi, (_match, inlineCode, name, code) => {
    if (inlineCode !== undefined) return stash(`<code>${escapeMarkdownHtml(inlineCode)}</code>`);
    hasHtml = true;
    name = name.toLowerCase();
    return stash(`<${name}>${escapeHtmlText(code)}</${name}>`);
  });
  const htmlStack = [];
  source = source.replace(htmlTagPattern, (match) => {
    const tag = safeHtmlTag(match);
    if (!tag) return stash(escapeMarkdownHtml(match));
    hasHtml = true;
    return stash(updateHtmlStack(htmlStack, tag));
  });
  source = source.replace(/!\[([^\]]*)]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) => {
    const src = safeUrl(url);
    return stash(src && /^https?:\/\//i.test(src)
      ? `<img src="${escapeMarkdownHtml(src)}" alt="${escapeMarkdownHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`
      : escapeMarkdownHtml(alt));
  });
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
  let html = (hasHtml ? escapeHtmlText(source) : escapeMarkdownHtml(source))
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<em>$2</em>');
  if (lineBreaks) html = html.replaceAll('\n', '<br>');
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    html = html.replaceAll(`${tokenPrefix}${index}\uE001`, tokens[index]);
  }
  return html + htmlStack.reverse().map((name) => `</${name}>`).join('');
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
    || hasHtmlBlock(line)
    || /^\s*(?:<details(?:\s+open)?>|<\/details>|<summary>.*<\/summary>)\s*$/i.test(line)
    || (line.includes('|') && /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/.test(next));
}

function hasHtmlBlock(value) {
  const source = value.replace(/`([^`\n]+)`|<(code|pre)>[\s\S]*?<\/\2>/gi,
    (_match, inlineCode, name) => name?.toLowerCase() === 'pre' ? '<pre></pre>' : '');
  return [...source.matchAll(htmlTagPattern)].some((match) => {
    const tag = safeHtmlTag(match[0]);
    return tag && !tag.closing && htmlBlocks.has(tag.name);
  });
}

export function renderMarkdown(value = '') {
  const lines = String(value).replaceAll('\r\n', '\n').split('\n');
  const output = [];
  let detailsDepth = 0;
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

    // Support GitHub's collapsible reference blocks without accepting arbitrary HTML.
    const details = /^\s*<details(\s+open)?>\s*$/i.exec(line);
    if (details) {
      output.push(details[1] ? '<details open>' : '<details>');
      detailsDepth += 1;
      index += 1;
      continue;
    }
    if (detailsDepth > 0 && /^\s*<\/details>\s*$/i.test(line)) {
      output.push('</details>');
      detailsDepth -= 1;
      index += 1;
      continue;
    }
    const summary = detailsDepth > 0 && /^\s*<summary>(.*)<\/summary>\s*$/i.exec(line);
    if (summary) {
      output.push(`<summary>${renderInline(summary[1])}</summary>`);
      index += 1;
      continue;
    }

    if (hasHtmlBlock(line)) {
      const block = [];
      const stack = [];
      do {
        const current = lines[index++];
        block.push(current);
        for (const match of current.matchAll(htmlTagPattern)) {
          const tag = safeHtmlTag(match[0]);
          if (tag) updateHtmlStack(stack, tag);
        }
      } while (index < lines.length && stack.length);
      output.push(renderInline(block.join('\n'), false));
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
  return output.join('') + '</details>'.repeat(detailsDepth);
}
