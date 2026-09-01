export interface StatusEditorEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
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
