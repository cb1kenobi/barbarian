let lastSelection;
let lastReviewSignalAt = 0;

function selectionSnapshot() {
  const selection = window.getSelection();
  const text = String(selection || '').trim();
  if (!text) return null;
  const elementFor = (node) => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const anchorElement = elementFor(selection?.anchorNode);
  const focusElement = elementFor(selection?.focusNode);
  const lineElement = anchorElement?.closest?.('[data-line-number], [data-position], .blob-code');
  const focusLineElement = focusElement?.closest?.('[data-line-number], [data-position], .blob-code');
  const fileElement = anchorElement?.closest?.('[data-path], [data-file-path], .file')
    || focusElement?.closest?.('[data-path], [data-file-path], .file')
    || lineElement?.closest?.('[data-path], [data-file-path], .file');
  const path = fileElement?.getAttribute('data-path')
    || fileElement?.getAttribute('data-file-path')
    || fileElement?.querySelector?.('[data-path]')?.getAttribute('data-path');
  const anchorLine = lineElement?.getAttribute('data-line-number') || lineElement?.getAttribute('data-position');
  const focusLine = focusLineElement?.getAttribute('data-line-number') || focusLineElement?.getAttribute('data-position');
  const lineNumbers = [anchorLine, focusLine]
    .filter((value) => value != null && value !== '')
    .map(Number)
    .filter(Number.isFinite);
  const line = lineNumbers.length ? String(Math.min(...lineNumbers)) : anchorLine || null;
  const endLine = lineNumbers.length ? String(Math.max(...lineNumbers)) : focusLine || line;
  const lineCount = lineNumbers.length ? Math.max(...lineNumbers) - Math.min(...lineNumbers) + 1
    : text.replaceAll('\r\n', '\n').split('\n').length;
  return { text: text.slice(0, 12_000), path: path || null, line, endLine, lineCount, url: location.href };
}

let selectionTimer;
document.addEventListener('selectionchange', () => {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => {
    const snapshot = selectionSnapshot();
    lastSelection = snapshot || undefined;
    void chrome.runtime.sendMessage({
      type: 'barbarian-selection-changed', url: location.href, selection: snapshot,
    }).catch(() => {});
  }, 75);
});

function selectedReviewAction(form) {
  const selected = form?.querySelector?.('[name="pull_request_review[event]"]:checked');
  const value = selected?.value?.toLowerCase();
  return ['approve', 'request_changes', 'comment'].includes(value) ? value : null;
}

function signalReviewSubmission(form) {
  const reviewAction = selectedReviewAction(form);
  const now = Date.now();
  if (!reviewAction || now - lastReviewSignalAt < 1_000) return;
  lastReviewSignalAt = now;
  void chrome.runtime.sendMessage({ type: 'barbarian-review-submitted', reviewAction }).catch(() => {});
}

// GitHub's review dialog is rendered dynamically. Capture both the native
// submit and the submit-button click so this survives its current form wiring.
document.addEventListener('submit', (event) => {
  signalReviewSubmission(event.target);
}, true);
document.addEventListener('click', (event) => {
  const submit = event.target?.closest?.('button[type="submit"], input[type="submit"]');
  if (submit?.form) signalReviewSubmission(submit.form);
}, true);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'barbarian-get-selection') return false;
  sendResponse(selectionSnapshot() || lastSelection || null);
  return false;
});
