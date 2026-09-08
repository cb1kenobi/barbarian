const cruft = /(^|\s)(fix|feat|chore|refactor|docs|test)(\([^)]*\))?:\s*/i;
const maximumSentenceLength = 2_400;
const maximumSummaryLength = 4_000;
const maximumSourceLength = 100_000;
const maximumHtmlTagLength = 1_024;
const escapedLessThan = '\ue000';
const escapedGreaterThan = '\ue001';
const discardedHtmlContainers = new Set(['canvas', 'iframe', 'object', 'pre', 'script', 'style', 'svg', 'template']);
const pairedHtmlElements = new Set([...discardedHtmlContainers, 'code']);
const knownHtmlElements = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo',
  'big', 'blockquote', 'body', 'br', 'button', 'canvas',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist', 'dd', 'del',
  'details', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption', 'figure',
  'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup',
  'hr', 'html',
  'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
  'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'section',
  'select', 'slot', 'small', 'source', 'span', 'strike', 'strong', 'style', 'sub', 'summary',
  'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title',
  'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr',
]);
const paragraphHtmlTags = new Set([
  'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'dt', 'dd', 'footer', 'header', 'main',
  'nav', 'ol', 'p', 'section', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul',
]);
const namedHtmlEntities: Record<string, string> = {
  amp: '&', apos: "'", bull: '•', copy: '©', hellip: '…', laquo: '«', ldquo: '“',
  larr: '←', lsquo: '‘', mdash: '—', middot: '·', nbsp: ' ', ndash: '–', quot: '"', raquo: '»',
  rdquo: '”', reg: '®', rarr: '→', rsquo: '’', trade: '™', zwnj: '', zwj: '',
};
const escapedHtmlTagPattern = new RegExp(
  `${escapedLessThan}(/?[A-Za-z][^${escapedLessThan}${escapedGreaterThan}\n\`]*?)${escapedGreaterThan}`,
  'g',
);

function decodeHtmlEntity(entity: string): string | null {
  if (!entity.startsWith('#')) {
    const name = entity.toLowerCase();
    if (name === 'lt') return escapedLessThan;
    if (name === 'gt') return escapedGreaterThan;
    return namedHtmlEntities[name] ?? null;
  }
  const hexadecimal = entity[1]?.toLowerCase() === 'x';
  const digits = entity.slice(hexadecimal ? 2 : 1);
  if (!(hexadecimal ? /^[0-9a-f]+$/i : /^\d+$/).test(digits)) return null;
  const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
  if (codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return null;
  if (codePoint === 60) return escapedLessThan;
  if (codePoint === 62) return escapedGreaterThan;
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  const output: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const ampersand = value.indexOf('&', cursor);
    if (ampersand < 0) {
      output.push(value.slice(cursor));
      break;
    }
    output.push(value.slice(cursor, ampersand));
    const entityLimit = Math.min(value.length, ampersand + 33);
    let semicolon = -1;
    for (let index = ampersand + 1; index < entityLimit; index += 1) {
      if (value[index] === '&') break;
      if (value[index] === ';') {
        semicolon = index;
        break;
      }
    }
    if (semicolon < 0) {
      output.push('&');
      cursor = ampersand + 1;
      continue;
    }
    const source = value.slice(ampersand, semicolon + 1);
    output.push(decodeHtmlEntity(value.slice(ampersand + 1, semicolon)) ?? source);
    cursor = semicolon + 1;
  }
  return output.join('');
}

function findHtmlTagEnd(value: string, start: number): number {
  let quote = '';
  const limit = Math.min(value.length, start + maximumHtmlTagLength + 1);
  for (let index = start + 1; index < limit; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '>') return index;
  }
  return -1;
}

function htmlTagReplacement(name: string, closing: boolean): string {
  if (/^h[1-6]$/.test(name)) return closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `;
  if (name === 'summary') return '\n\n';
  if (name === 'li') return closing ? '\n' : '\n- ';
  if (name === 'br') return '\n';
  if (name === 'hr' || paragraphHtmlTags.has(name)) return '\n\n';
  if (name === 'td' || name === 'th') return ' | ';
  return '';
}

function restoreEscapedAngles(value: string): string {
  return value
    .replace(escapedHtmlTagPattern, (_match, content: string) => `\`<${content}>\``)
    .replaceAll(escapedLessThan, '<')
    .replaceAll(escapedGreaterThan, '>');
}

function markdownCodeEnd(source: string, start: number): number {
  let delimiterEnd = start + 1;
  while (source[delimiterEnd] === '`') delimiterEnd += 1;
  const delimiter = source.slice(start, delimiterEnd);
  const closingStart = source.indexOf(delimiter, delimiterEnd);
  return closingStart < 0 ? delimiterEnd : closingStart + delimiter.length;
}

function pairedHtmlContainers(source: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stacks = new Map<string, number[]>();
  let cursor = 0;
  while (cursor < source.length) {
    const nextCode = source.indexOf('`', cursor);
    const nextTag = source.indexOf('<', cursor);
    if (nextCode >= 0 && (nextTag < 0 || nextCode < nextTag)) {
      cursor = markdownCodeEnd(source, nextCode);
      continue;
    }
    if (nextTag < 0) break;
    if (source.startsWith('<!--', nextTag)) {
      const commentEnd = source.indexOf('-->', nextTag + 4);
      cursor = commentEnd < 0 ? nextTag + 4 : commentEnd + 3;
      continue;
    }
    if (!/^<\/?[A-Za-z]/.test(source.slice(nextTag, nextTag + 8))) {
      cursor = nextTag + 1;
      continue;
    }
    const tagEnd = findHtmlTagEnd(source, nextTag);
    if (tagEnd < 0) {
      const malformedClose = /^<\/([A-Za-z][A-Za-z0-9:-]*)(?:\s|$)/
        .exec(source.slice(nextTag, Math.min(source.length, nextTag + 80)));
      const name = malformedClose?.[1]?.toLowerCase();
      if (name && pairedHtmlElements.has(name)) {
        const opening = stacks.get(name)?.pop();
        if (opening !== undefined) pairs.set(opening, nextTag);
      }
      cursor = nextTag + 1;
      continue;
    }
    const candidate = source.slice(nextTag + 1, tagEnd);
    const match = /^(\/)?([A-Za-z][A-Za-z0-9:-]*)(?:\s|\/|$)/.exec(candidate);
    const name = match?.[2]?.toLowerCase();
    if (name && pairedHtmlElements.has(name)) {
      if (match?.[1]) {
        const opening = stacks.get(name)?.pop();
        if (opening !== undefined) pairs.set(opening, nextTag);
      } else if (tagEnd >= 0 && !/\/\s*$/.test(candidate)) {
        let stack = stacks.get(name);
        if (!stack) {
          stack = [];
          stacks.set(name, stack);
        }
        stack.push(nextTag);
      }
    }
    cursor = tagEnd + 1;
  }
  return pairs;
}

export function normalizeSummaryMarkup(value: string): string {
  const bounded = (value.length <= maximumSourceLength ? value : value.slice(0, maximumSourceLength))
    .replaceAll(escapedLessThan, '')
    .replaceAll(escapedGreaterThan, '');
  if (!bounded.includes('<') && !bounded.includes('&')) return bounded;
  const source = decodeHtmlEntities(bounded);
  if (!source.includes('<')) return restoreEscapedAngles(source);
  const output: string[] = [];
  const pairedContainers = pairedHtmlContainers(source);
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '`') {
      const closingEnd = markdownCodeEnd(source, cursor);
      output.push(source.slice(cursor, closingEnd));
      cursor = closingEnd;
      continue;
    }
    if (source[cursor] !== '<') {
      const nextTag = source.indexOf('<', cursor);
      const nextCode = source.indexOf('`', cursor);
      const next = nextTag < 0 ? nextCode : nextCode < 0 ? nextTag : Math.min(nextTag, nextCode);
      output.push(source.slice(cursor, next < 0 ? source.length : next));
      cursor = next < 0 ? source.length : next;
      continue;
    }
    if (source.startsWith('<!--', cursor)) {
      const commentEnd = source.indexOf('-->', cursor + 4);
      cursor = commentEnd < 0 ? cursor + 4 : commentEnd + 3;
      continue;
    }
    if (!/^<\/?[A-Za-z]/.test(source.slice(cursor, cursor + 8))) {
      if (source.startsWith('<!', cursor) || source.startsWith('<?', cursor)) {
        const declarationEnd = findHtmlTagEnd(source, cursor);
        cursor = declarationEnd < 0 ? cursor + 2 : declarationEnd + 1;
        continue;
      }
      output.push('<');
      cursor += 1;
      continue;
    }
    const tagEnd = findHtmlTagEnd(source, cursor);
    if (tagEnd < 0) {
      const name = /^<\/?([A-Za-z][A-Za-z0-9:-]*)/.exec(source.slice(cursor, cursor + 80))?.[1]?.toLowerCase();
      if (name && discardedHtmlContainers.has(name)) {
        output.push('\n\n');
        cursor = source.length;
        continue;
      }
      if (!name || !knownHtmlElements.has(name)) output.push('<');
      cursor += 1;
      continue;
    }
    const tag = source.slice(cursor + 1, tagEnd);
    const match = /^\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(tag);
    if (!match) {
      output.push(source.slice(cursor, tagEnd + 1));
      cursor = tagEnd + 1;
      continue;
    }
    const closing = Boolean(match[1]);
    const name = match[2]!.toLowerCase();
    if (!knownHtmlElements.has(name)) {
      output.push(source.slice(cursor, tagEnd + 1));
      cursor = tagEnd + 1;
      continue;
    }
    if (!closing && discardedHtmlContainers.has(name)) {
      const closingStart = pairedContainers.get(cursor) ?? -1;
      if (closingStart >= 0) {
        const closingEnd = findHtmlTagEnd(source, closingStart);
        cursor = closingEnd < 0 ? source.length : closingEnd + 1;
        output.push('\n\n');
        continue;
      }
    }
    if (!closing && name === 'code') {
      const closingStart = pairedContainers.get(cursor) ?? -1;
      const closingEnd = closingStart < 0 ? -1 : findHtmlTagEnd(source, closingStart);
      const code = closingStart < 0 ? '' : source.slice(tagEnd + 1, closingStart).trim();
      if (closingStart - tagEnd <= maximumHtmlTagLength && closingEnd >= 0 && code && !/[\n`<>]/.test(code)) {
        output.push(`\`${code}\``);
        cursor = closingEnd + 1;
        continue;
      }
    }
    output.push(htmlTagReplacement(name, closing));
    cursor = tagEnd + 1;
  }
  return restoreEscapedAngles(output.join('').slice(0, maximumSourceLength)).slice(0, maximumSourceLength);
}

function truncateAtWord(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const prefix = value.slice(0, limit - 1);
  const boundary = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, boundary > limit * 0.7 ? boundary : prefix.length).trimEnd()}…`;
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/<!--[^]*?-->/g, '')
    .replace(/```[^]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1$2')
    .replace(/\|/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

function usefulParagraphs(value: string): string[] {
  return cleanMarkdown(value)
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#{1,6}\s+[^\n]+\n?/, '').replace(/\s+/g, ' ').trim())
    .filter((part) => part.length >= 24 && !/^(generated|signed|review-coverage|human-review-need)\b/i.test(part));
}

function shortExplanation(value: string, limit = 330): string {
  const sentences = value.split(/(?<=[.!?])\s+/).filter(Boolean);
  const selected = (sentences.slice(0, 2).join(' ') || value).trim();
  return selected.length <= limit ? selected : `${selected.slice(0, limit - 1).trimEnd()}…`;
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sentenceCandidates(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => truncateAtWord(sentence.replace(/\s+/g, ' ').trim(), maximumSentenceLength))
    .filter((sentence) => sentence.length >= 20 && !/^https?:\/\/\S+$/i.test(sentence));
}

function joinCompleteSentences(sentences: string[]): string {
  const selected: string[] = [];
  for (const sentence of sentences) {
    if (selected.length && selected.join(' ').length + sentence.length + 1 > maximumSummaryLength) break;
    selected.push(sentence);
  }
  return selected.join(' ');
}

function markdownSections(body: string): Array<{ heading: string; body: string }> {
  return [...body.matchAll(/^#{1,6}[ \t]+([^\r\n]+?)[ \t]*\r?\n([\s\S]*?)(?=^#{1,6}[ \t]+|(?![\s\S]))/gm)]
    .map((match) => ({ heading: match[1]?.trim() || '', body: usefulParagraphs(match[2] || '').join(' ') }))
    .filter((section) => section.body);
}

export function simplify(title: string, body = ''): string {
  body = normalizeSummaryMarkup(body);
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const firstSentence = body
    .replace(/<!--[^]*?-->/g, '')
    .replace(/```[^]*?```/g, '')
    .replace(/^[ \t]*[-+][ \t]+/gm, '')
    .replace(/[#>*\[\]]/g, '')
    .split(/(?<=[.!?])\s|\n{2,}/)
    .map((part) => part.trim())
    .find((part) => part.length >= 20 && part.length <= 180);
  if (!firstSentence) return cleanTitle;
  return `${cleanTitle}. ${firstSentence}`.slice(0, 240);
}

function summarizeNormalizedPullRequest(title: string, body: string): string {
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const normalizedTitle = normalizedText(cleanTitle);
  const paragraphs = usefulParagraphs(body)
    .filter((paragraph) => !/(?:🤖\s*)?generated with|review checklist|test plan/i.test(paragraph));
  const sections = markdownSections(body)
    .filter((section) => !/test|checklist|screenshots?|documentation/i.test(section.heading));
  const preferredSections = sections.filter((section) =>
    /summary|overview|description|what this is|problem|why|context|motivation|root cause|solution|fix|implementation|approach|what changed|changes|migration guide/i.test(section.heading),
  );
  const firstHeading = body.search(/^#{1,6}[ \t]+/m);
  const intro = firstHeading > 0 ? usefulParagraphs(body.slice(0, firstHeading))[0] : undefined;
  const sources = (preferredSections.length
    ? [intro, ...preferredSections.map((section) => section.body)]
    : paragraphs.slice(0, 2))
    .filter((source): source is string => Boolean(source));
  const seenSources = new Set<string>();
  const seenSentences = new Set<string>();
  const sentences: string[] = [];

  for (const [index, source] of sources.entries()) {
    const normalizedSource = normalizedText(source);
    if (!normalizedSource || seenSources.has(normalizedSource)) continue;
    seenSources.add(normalizedSource);
    const desiredFromSource = sources.length === 1 ? 4 : index === sources.length - 1 ? 2 : 1;
    const sourceLimit = Math.min(desiredFromSource, 4 - sentences.length);
    let selectedFromSource = 0;
    for (const sentence of sentenceCandidates(source)) {
      const normalizedSentence = normalizedText(sentence);
      if (!normalizedSentence || normalizedSentence === normalizedTitle || seenSentences.has(normalizedSentence)) continue;
      seenSentences.add(normalizedSentence);
      sentences.push(sentence);
      selectedFromSource += 1;
      if (sentences.length === 4 || selectedFromSource === sourceLimit) break;
    }
    if (sentences.length === 4) break;
  }

  if (!sentences.length) return 'No additional description was provided.';
  return joinCompleteSentences(sentences);
}

function explainNormalizedPullRequest(title: string, body: string): string {
  const cleanTitle = title.replace(cruft, '').replace(/\s+/g, ' ').trim();
  const sections = markdownSections(body);
  const paragraphs = usefulParagraphs(body);
  const problemSection = sections.find((section) => /problem|why|context|motivation|root cause|summary/i.test(section.heading));
  const solutionSection = sections.find((section) => /solution|fix|implementation|approach|what changed|changes/i.test(section.heading));
  const problem = shortExplanation(problemSection?.body || paragraphs[0] || cleanTitle);
  const fallbackSolution = paragraphs.find((paragraph) => paragraph !== paragraphs[0])
    || `This change updates the code so ${cleanTitle.charAt(0).toLowerCase()}${cleanTitle.slice(1)}.`;
  const solution = shortExplanation(solutionSection?.body || fallbackSolution);
  return `Problem: ${problem}\n\nSolution: ${solution}`;
}

export function summarizePullRequest(title: string, body = ''): string {
  return summarizeNormalizedPullRequest(title, normalizeSummaryMarkup(body));
}

export function explainPullRequest(title: string, body = ''): string {
  return explainNormalizedPullRequest(title, normalizeSummaryMarkup(body));
}

export function pullRequestSummaries(title: string, body = ''): {
  simpleSummary: string;
  plainSummary: string;
} {
  const normalizedBody = normalizeSummaryMarkup(body);
  return {
    simpleSummary: summarizeNormalizedPullRequest(title, normalizedBody),
    plainSummary: explainNormalizedPullRequest(title, normalizedBody),
  };
}
