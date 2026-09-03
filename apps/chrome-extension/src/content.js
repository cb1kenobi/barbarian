let lastSelection;
let runtimeAvailable = true;

function sendRuntimeMessage(message) {
  if (!runtimeAvailable) return;
  try {
    const pending = chrome.runtime.sendMessage(message);
    if (pending && typeof pending.catch === 'function') {
      void pending.catch((error) => {
        if (/extension context invalidated/i.test(String(error))) runtimeAvailable = false;
      });
    }
  } catch {
    runtimeAvailable = false;
  }
}

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
    sendRuntimeMessage({
      type: 'barbarian-selection-changed', url: location.href, selection: snapshot,
    });
  }, 75);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'barbarian-get-selection') return false;
  sendResponse(selectionSnapshot() || lastSelection || null);
  return false;
});

function isIssuePage() {
  return /^\/[^/]+\/[^/]+\/issues\/\d+(?:\/|$)/.test(location.pathname);
}

function isPullRequestPage() {
  return /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/.test(location.pathname);
}

function assigneeInteraction(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const elements = [event.target, ...path].filter((value) => value instanceof Element);
  return elements.some((element) => {
    const clue = [
      element.getAttribute('aria-label'), element.getAttribute('data-testid'),
      element.getAttribute('title'), element.id, element.className,
    ].filter((value) => typeof value === 'string').join(' ');
    return /assignee|assign-yourself/i.test(clue);
  });
}

let issueRefreshTimer;
function signalIssueUpdate(delay = 150) {
  clearTimeout(issueRefreshTimer);
  issueRefreshTimer = setTimeout(() => {
    if (!isIssuePage()) return;
    sendRuntimeMessage({ type: 'barbarian-issue-updated', url: location.href });
  }, delay);
}

function mergeInteraction(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  const controls = [event.target, ...path]
    .filter((value) => value instanceof Element)
    .map((element) => element.closest?.('button, input[type="submit"], [role="button"]'))
    .filter(Boolean);
  return controls.some((control) => {
    const clue = [
      control.textContent, control.getAttribute('aria-label'), control.getAttribute('data-testid'),
      control.getAttribute('name'), control.getAttribute('value'), control.getAttribute('title'),
    ].filter((value) => typeof value === 'string').join(' ');
    return /(?:confirm |squash and |rebase and |queue |auto-?)?merge(?: pull request| when ready)?/i.test(clue);
  });
}

let pullRequestRefreshTimer;
function signalPullRequestUpdate(delay = 150) {
  clearTimeout(pullRequestRefreshTimer);
  pullRequestRefreshTimer = setTimeout(() => {
    if (!isPullRequestPage()) return;
    sendRuntimeMessage({
      type: 'barbarian-pull-request-updated', url: location.href,
    });
  }, delay);
}

document.addEventListener('click', (event) => {
  if (isIssuePage() && assigneeInteraction(event)) signalIssueUpdate(250);
  else if (isPullRequestPage() && mergeInteraction(event)) signalPullRequestUpdate(350);
}, true);

document.addEventListener('turbo:submit-end', () => {
  if (isIssuePage()) signalIssueUpdate(250);
  else if (isPullRequestPage()) signalPullRequestUpdate(250);
});

document.addEventListener('turbo:load', () => {
  if (isPullRequestPage()) signalPullRequestUpdate(100);
});

document.addEventListener('pjax:end', () => {
  if (isPullRequestPage()) signalPullRequestUpdate(100);
});
