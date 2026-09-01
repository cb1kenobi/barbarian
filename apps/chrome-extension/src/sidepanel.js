let currentTab;
let currentPrKey = '';
let currentContext;
let busy = false;
let lastSelection;

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character]);

function parsePullRequest(url = '') {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com') return null;
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    return match ? { key: `${match[1]}/${match[2]}#${match[3]}` } : null;
  } catch { return null; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function api(path, options) {
  const response = await chrome.runtime.sendMessage({
    type: 'barbarian-api', path,
    options: options ? { method: options.method, body: options.body } : undefined,
  });
  if (!response?.ok) throw new Error(response?.body?.error || response?.error || response?.statusText || 'Barbarian request failed');
  return response.body;
}

function findingState(finding) {
  if (finding.resolved) return { symbol: '✓', label: 'Resolved', className: 'resolved' };
  if (finding.outdated) return { symbol: '–', label: 'Outdated', className: 'outdated' };
  return { symbol: '!', label: 'Unresolved', className: 'open' };
}

function renderFindings(findings) {
  if (!findings.length) return '<p class="empty">No linked AI review comments yet.</p>';
  return `<div class="findings">${findings.map((finding) => {
    const state = findingState(finding);
    const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : 'Conversation';
    return `<article class="finding ${state.className}"><div class="finding-top"><span class="state" title="${state.label}">${state.symbol}</span><a class="finding-summary" href="${escapeHtml(finding.url)}" data-github-url>${escapeHtml(finding.summary || 'Open review comment')}</a></div><p class="finding-meta">${escapeHtml(state.label)} · ${escapeHtml(location)} · ${escapeHtml(finding.author)}</p></article>`;
  }).join('')}</div>`;
}

function renderMessages(messages = []) {
  if (!messages.length) return '';
  return `<div class="transcript">${messages.map((message) => `<div class="message ${message.role === 'user' ? 'user' : 'assistant'}"><span class="message-author">${escapeHtml(message.author)}</span>${escapeHtml(message.content)}</div>`).join('')}</div>`;
}

function updateSelectionPreview() {
  const preview = document.querySelector('.selection');
  if (!preview) return;
  if (!lastSelection) {
    preview.classList.remove('visible');
    preview.textContent = '';
    return;
  }
  const location = lastSelection.path ? `${lastSelection.path}${lastSelection.line ? `:${lastSelection.line}` : ''} — ` : '';
  preview.textContent = `${location}${lastSelection.text.replace(/\s+/g, ' ')}`;
  preview.title = lastSelection.text;
  preview.classList.add('visible');
}

function renderContext(context) {
  currentContext = context;
  const main = document.querySelector('main');
  if (!context.review) {
    main.innerHTML = '<p class="empty">This pull request is not in Barbarian’s review queue. Run a sync after adding its repository to <code>config/barbarian.yaml</code>.</p>';
    return;
  }
  const { review, assessment, findings = [], messages = [] } = context;
  const summary = review.plain_summary || review.simple_summary || 'Barbarian does not have a summary for this pull request yet.';
  const counts = assessment?.counts || { open: review.findings_count || 0, resolved: 0, outdated: 0, total: review.findings_count || 0 };
  const reviewRunning = review.status === 'agent_working' || Boolean(review.manual_requested_at);
  main.innerHTML = `
    <div class="status ${escapeHtml(assessment?.tone || 'attention')}">${escapeHtml(assessment?.label || 'Needs Review')}</div>
    <section class="review-actions"><h2>Review actions</h2><div class="actions"><button class="agent-review${reviewRunning ? ' running' : ''}" data-running="${reviewRunning}"><span class="button-icon" aria-hidden="true">${reviewRunning ? '■' : '▶'}</span><span>${reviewRunning ? 'Stop agent review' : 'Agent review'}</span></button><button class="secondary test-locally">Test locally</button></div><p class="action-status"></p>${review.workspace_path ? `<code class="workspace-path">${escapeHtml(review.workspace_path)}</code>` : ''}</section>
    <section><h2>AI assessment</h2><div class="assessment"><p class="assessment-message">${escapeHtml(assessment?.message || 'Waiting for an AI review.')}</p>${assessment?.stale ? '<p class="stale">⚠ This assessment is older than the latest commit.</p>' : ''}<div class="counts"><div class="count"><strong>${Number(counts.open) || 0}</strong><span>Open</span></div><div class="count"><strong>${Number(counts.resolved) || 0}</strong><span>Resolved</span></div><div class="count"><strong>${Number(counts.outdated) || 0}</strong><span>Outdated</span></div><div class="count"><strong>${Number(counts.total) || 0}</strong><span>Total</span></div></div></div></section>
    <section><h2>Summary</h2><p class="summary">${escapeHtml(summary)}</p></section>
    <section><h2>AI review comments</h2>${renderFindings(findings)}</section>
    <section><h2>Ask about this PR</h2>${renderMessages(messages)}<p class="selection"></p><textarea placeholder="Ask what changed, why it works, what could break, or how to test it…"></textarea><div class="actions"><button class="ask-pr">Ask about PR</button><button class="secondary ask-selection">Ask about selection</button></div><p class="error"></p><div class="reply"><span class="reply-label">AGENT REPLY</span><span class="reply-text"></span></div></section>`;
  document.querySelector('.ask-pr')?.addEventListener('click', () => void sendQuestion('pr'));
  document.querySelector('.ask-selection')?.addEventListener('click', () => void sendQuestion('selection'));
  document.querySelector('.agent-review')?.addEventListener('click', () => void runReviewAction('review'));
  document.querySelector('.test-locally')?.addEventListener('click', () => void runReviewAction('workspace'));
  document.querySelectorAll('[data-github-url]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    if (currentTab?.id) void chrome.tabs.update(currentTab.id, { url: link.href });
  }));
  updateSelectionPreview();
}

async function runReviewAction(kind) {
  if (busy || !currentContext?.review) return;
  const status = document.querySelector('.action-status');
  busy = true;
  status.classList.remove('error');
  const reviewButton = document.querySelector('.agent-review');
  const stoppingReview = kind === 'review' && reviewButton?.dataset.running === 'true';
  status.textContent = kind === 'review'
    ? stoppingReview ? 'Stopping every agent working on this PR…' : 'Starting the review agent…'
    : 'Cloning, installing, and building…';
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    if (kind === 'review') {
      if (stoppingReview) {
        const result = await api(`/api/reviews/${encodeURIComponent(currentContext.review.id)}/run-review`, {
          method: 'DELETE',
        });
        if (result.stopped) {
          currentContext.review.status = 'unreviewed';
          currentContext.review.review_paused = true;
          setReviewButton(false);
          status.textContent = result.cancelled
            ? `Stopped ${result.cancelled} in-flight agent ${result.cancelled === 1 ? 'process' : 'processes'}.`
            : 'Agent review request cancelled.';
        } else {
          status.textContent = 'The agent review already finished.';
          setTimeout(() => void refresh(), 0);
        }
      } else {
        await api(`/api/reviews/${encodeURIComponent(currentContext.review.id)}/run-review`, {
          method: 'POST', body: '{}',
        });
        currentContext.review.status = 'agent_working';
        currentContext.review.review_paused = false;
        setReviewButton(true);
        status.textContent = 'Agent review started. Click stop to cancel every agent working on this PR.';
        setTimeout(() => void refresh({ quiet: true }), 1_000);
      }
    } else {
      const result = await api(`/api/reviews/${encodeURIComponent(currentContext.review.id)}/workspace`, {
        method: 'POST', body: '{}',
      });
      currentContext.review.workspace_path = result.workspace;
      status.textContent = `Local test workspace is ready: ${result.workspace}`;
      const path = document.querySelector('.workspace-path');
      if (path) path.textContent = result.workspace;
      else {
        const created = document.createElement('code');
        created.className = 'workspace-path';
        created.textContent = result.workspace;
        status.after(created);
      }
    }
  } catch (caught) {
    status.textContent = caught.message;
    status.classList.add('error');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

function setReviewButton(running) {
  const button = document.querySelector('.agent-review');
  if (!button) return;
  button.dataset.running = String(running);
  button.classList.toggle('running', running);
  button.innerHTML = `<span class="button-icon" aria-hidden="true">${running ? '■' : '▶'}</span><span>${running ? 'Stop agent review' : 'Agent review'}</span>`;
}

async function captureSelection() {
  const selection = await chrome.runtime.sendMessage({ type: 'barbarian-active-selection' });
  if (selection?.text) lastSelection = selection;
  updateSelectionPreview();
  return lastSelection;
}

async function sendQuestion(kind) {
  if (busy || !currentContext?.review) return;
  const input = document.querySelector('textarea');
  const error = document.querySelector('.error');
  const reply = document.querySelector('.reply');
  const replyText = document.querySelector('.reply-text');
  const question = input?.value.trim() || '';
  if (kind === 'selection') await captureSelection();
  if (kind === 'pr' && !question) { error.textContent = 'Write a question first.'; input?.focus(); return; }
  if (kind === 'selection' && !lastSelection) { error.textContent = 'Select lines on the GitHub page first.'; return; }
  const selectionContext = kind === 'selection'
    ? `\n\nSelected code${lastSelection.path ? ` from ${lastSelection.path}${lastSelection.line ? `:${lastSelection.line}` : ''}` : ''}:\n\n${lastSelection.text}\n\nGitHub location: ${lastSelection.url}`
    : '';
  const message = `${question || 'Explain this selected code and how it relates to the pull request.'}${selectionContext}`;
  busy = true;
  error.textContent = 'Agent is thinking…';
  reply?.classList.remove('visible');
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const result = await api(`/api/reviews/${encodeURIComponent(currentContext.review.id)}/chat`, {
      method: 'POST', body: JSON.stringify({ message, askAgent: true, author: 'GitHub extension' }),
    });
    if (input) input.value = '';
    if (replyText) replyText.textContent = result.message?.content || 'The response was saved in Barbarian.';
    reply?.classList.add('visible');
    error.textContent = '';
  } catch (caught) { error.textContent = caught.message; }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

async function refresh({ quiet = false } = {}) {
  if (busy) return;
  const tab = await activeTab();
  const pr = parsePullRequest(tab?.url);
  currentTab = tab;
  if (!pr) {
    currentPrKey = '';
    currentContext = undefined;
    document.querySelector('.pr-key').textContent = 'GitHub review';
    document.querySelector('main').innerHTML = '<p class="empty">Open a tracked GitHub pull request to use Barbarian.</p>';
    return;
  }
  if (pr.key !== currentPrKey) {
    currentPrKey = pr.key;
    currentContext = undefined;
    lastSelection = undefined;
  }
  document.querySelector('.pr-key').textContent = pr.key;
  try {
    renderContext(await api(`/api/browser/context?url=${encodeURIComponent(tab.url)}`));
  } catch (caught) {
    if (quiet && currentContext) return;
    document.querySelector('main').innerHTML = `<p class="offline"><strong>Barbarian is offline.</strong>${escapeHtml(caught.message)}</p><p class="empty">Start the local server and this panel will reconnect automatically.</p>`;
  }
}

chrome.tabs.onActivated.addListener(() => void refresh());
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === currentTab?.id && (change.url || change.status === 'complete')) void refresh();
});
setInterval(() => { if (!document.hidden && !busy && !document.querySelector('textarea')?.value) void refresh({ quiet: true }); }, 30_000);
void refresh();
