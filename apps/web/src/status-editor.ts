export interface StatusEditorEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

export interface StatusClipboardContent {
  plain: string;
  html: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function statusClipboardContent(value: string): StatusClipboardContent {
  const plain = value.replace(/^(\s*)[-+*•]\s+/gm, '$1• ');
  const html: string[] = [];
  let listItems: string[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    html.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join('')}</ul>`);
    listItems = [];
  };
  for (const line of value.split(/\r?\n/)) {
    const bullet = /^\s*[-+*•]\s+(.*)$/.exec(line);
    if (bullet) {
      listItems.push(escapeHtml(bullet[1] || ''));
      continue;
    }
    flushList();
    html.push(line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>');
  }
  flushList();
  return { plain, html: html.join('') };
}

export async function copyStatusUpdate(value: string): Promise<void> {
  const content = statusClipboardContent(value);
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard.write === 'function') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([content.plain], { type: 'text/plain' }),
        'text/html': new Blob([content.html], { type: 'text/html' }),
      })]);
      return;
    } catch {
      // Some browsers expose rich clipboard APIs but permit only plain-text writes.
    }
  }
  await navigator.clipboard.writeText(content.plain);
}

function insertAtSelection(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string,
): StatusEditorEdit {
  const cursor = selectionStart + text.length;
  return {
    value: value.slice(0, selectionStart) + text + value.slice(selectionEnd),
    selectionStart: cursor,
    selectionEnd: cursor,
  };
}

export function editStatusText(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  key: string,
  shiftKey = false,
): StatusEditorEdit | null {
  if (key === 'Tab' && !shiftKey) {
    if (selectionStart === selectionEnd) {
      return insertAtSelection(value, selectionStart, selectionEnd, '  ');
    }

    const firstLineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    const endsAtNextLineStart = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n';
    const blockEnd = endsAtNextLineStart ? selectionEnd - 1 : selectionEnd;
    const block = value.slice(firstLineStart, blockEnd);
    const lines = block.split('\n');
    const indented = lines.map((line) => `  ${line}`).join('\n');
    const added = lines.length * 2;
    return {
      value: value.slice(0, firstLineStart) + indented + value.slice(blockEnd),
      selectionStart: selectionStart + 2,
      selectionEnd: selectionEnd + added,
    };
  }

  if (key !== 'Enter') return null;

  const lineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const lineBeforeCursor = value.slice(lineStart, selectionStart);
  const bullet = /^(\s*)([-+*•])\s+/.exec(lineBeforeCursor);
  if (!bullet) return null;

  return insertAtSelection(value, selectionStart, selectionEnd, `\n${bullet[1]}${bullet[2]} `);
}
