export function selectedLineCount(selection) {
  if (Number.isInteger(selection?.lineCount) && selection.lineCount > 0) return selection.lineCount;
  if (!selection?.text) return 0;
  return String(selection.text).replaceAll('\r\n', '\n').split('\n').length;
}

export function selectionLabel(selection) {
  const count = selectedLineCount(selection);
  return `${count} ${count === 1 ? 'line' : 'lines'} selected`;
}

function selectedLineNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function selectionPayload(selection) {
  const line = selectedLineNumber(selection?.line);
  const endLine = selectedLineNumber(selection?.endLine);
  return {
    text: String(selection?.text || '').slice(0, 16_000),
    ...(selection?.path ? { path: selection.path } : {}),
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
    ...(selection?.url ? { url: selection.url } : {}),
  };
}

export function selectionPromptContext(selection) {
  const count = selectedLineCount(selection);
  const range = selection.path
    ? ` from ${selection.path}${selection.line ? `:${selection.line}${selection.endLine && selection.endLine !== selection.line ? `-${selection.endLine}` : ''}` : ''}`
    : '';
  return `\n\nSelected ${count} ${count === 1 ? 'line' : 'lines'}${range}:\n\n<selected_code>\n${selection.text}\n</selected_code>\n\nGitHub location: ${selection.url}`;
}
