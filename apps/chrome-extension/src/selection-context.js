export function selectedLineCount(selection) {
  if (Number.isInteger(selection?.lineCount) && selection.lineCount > 0) return selection.lineCount;
  if (!selection?.text) return 0;
  return String(selection.text).replaceAll('\r\n', '\n').split('\n').length;
}

export function selectionLabel(selection) {
  const count = selectedLineCount(selection);
  return `${count} ${count === 1 ? 'line' : 'lines'} selected`;
}

export function selectionPromptContext(selection) {
  const count = selectedLineCount(selection);
  const range = selection.path
    ? ` from ${selection.path}${selection.line ? `:${selection.line}${selection.endLine && selection.endLine !== selection.line ? `-${selection.endLine}` : ''}` : ''}`
    : '';
  return `\n\nSelected ${count} ${count === 1 ? 'line' : 'lines'}${range}:\n\n<selected_code>\n${selection.text}\n</selected_code>\n\nGitHub location: ${selection.url}`;
}
