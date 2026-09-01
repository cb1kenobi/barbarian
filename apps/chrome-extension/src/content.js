let lastSelection;

function selectionSnapshot() {
  const selection = window.getSelection();
  const text = String(selection || '').trim();
  if (!text) return null;
  const element = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection?.anchorNode?.parentElement;
  const lineElement = element?.closest?.('[data-line-number], [data-position], .blob-code');
  const fileElement = element?.closest?.('[data-path], [data-file-path], .file')
    || lineElement?.closest?.('[data-path], [data-file-path], .file');
  const path = fileElement?.getAttribute('data-path')
    || fileElement?.getAttribute('data-file-path')
    || fileElement?.querySelector?.('[data-path]')?.getAttribute('data-path');
  const line = lineElement?.getAttribute('data-line-number') || lineElement?.getAttribute('data-position');
  return { text: text.slice(0, 12_000), path: path || null, line: line || null, url: location.href };
}

document.addEventListener('selectionchange', () => {
  const snapshot = selectionSnapshot();
  if (snapshot) lastSelection = snapshot;
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'barbarian-get-selection') return false;
  sendResponse(selectionSnapshot() || lastSelection || null);
  return false;
});
