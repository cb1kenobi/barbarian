import {
  appearanceStorageKey, applyAppearance, rememberAppearance, restoreAppearance,
} from './appearance.js';
import { pullRequestSummary } from './review-content.js';
import { renderMarkdown } from './markdown.js';
import { shouldSubmitQuestion } from './chat-input.js';
import { selectionLabel, selectionPromptContext } from './selection-context.js';

let currentTab;
let currentPageKey = '';
let currentPageKind = '';
let currentContext;
let busy = false;
let lastSelection;

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character]);

function parseGitHubPage(url = '') {
  try {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://github.com') return null;
    const pullRequest = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (pullRequest) return { kind: 'pullRequest', key: `${pullRequest[1]}/${pullRequest[2]}#${pullRequest[3]}` };
    const issue = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/);
    return issue ? { kind: 'issue', key: `${issue[1]}/${issue[2]}#${issue[3]}` } : null;
  } catch { return null; }
}

function renderIssueContext(context) {
  const main = document.querySelector('main');
  if (!context.issue) {
    main.innerHTML = context.configured === false
      ? '<p class="empty">This repository is not configured for issue tracking in <code>config/barbarian.yaml</code>.</p>'
      : '<p class="empty">This issue is not available in Barbarian yet.</p>';
    return;
  }
  const { issue, messages = [] } = context;
  const closed = issue.remote_state !== 'OPEN' && issue.remote_state !== 'UNTRACKED';
  const status = closed ? 'Closed' : context.tracked ? 'In issue queue' : 'Not in issue queue';
  const tone = context.tracked ? 'attention' : 'quiet';
  const assignees = Array.isArray(issue.assignees) && issue.assignees.length ? issue.assignees.join(', ') : 'No one';
  const reasons = Array.isArray(issue.priority_reasons) && issue.priority_reasons.length
    ? issue.priority_reasons.join(' · ') : 'No priority signals';
  main.innerHTML = `
    <div class="status ${tone}">${escapeHtml(status)}</div>
    <section><h2>Summary</h2><p class="summary">${escapeHtml(issue.simple_summary || issue.title)}</p></section>
    <section><h2>Issue context</h2><dl class="issue-context"><div><dt>Assigned to</dt><dd>${escapeHtml(assignees)}</dd></div><div><dt>Priority</dt><dd>${Number(issue.priority) || 0} · ${escapeHtml(reasons)}</dd></div>${issue.milestone ? `<div><dt>Milestone</dt><dd>${escapeHtml(issue.milestone)}</dd></div>` : ''}${issue.duplicate_of ? `<div><dt>Duplicate of</dt><dd>${escapeHtml(issue.duplicate_of)}</dd></div>` : ''}${issue.in_progress_pr ? `<div><dt>Pull request</dt><dd><a href="${escapeHtml(issue.in_progress_pr)}" data-github-url>In progress</a></dd></div>` : ''}${issue.fixed_by ? `<div><dt>Fixed by</dt><dd><a href="${escapeHtml(issue.fixed_by)}" data-github-url>Merged pull request</a></dd></div>` : ''}</dl></section>
    <section class="review-room"><h2>Issue Room</h2><div class="conversation">${renderMessages(messages)}<div class="reply"><span class="reply-label">AGENT REPLY</span><div class="reply-text"></div></div></div><textarea placeholder="Ask about the problem, likely causes, scope, or how to verify a fix…"></textarea><p class="error"></p></section>`;
  document.querySelector('textarea')?.addEventListener('keydown', (event) => {
    if (!shouldSubmitQuestion(event.key, event.shiftKey, event.isComposing)) return;
    event.preventDefault();
    void sendQuestion('issue');
  });
  document.querySelectorAll('[data-github-url]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    if (currentTab?.id) void chrome.tabs.update(currentTab.id, { url: link.href });
  }));
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

function setAppearance(value) {
  if (!value) return null;
  const appearance = applyAppearance(value);
  void rememberAppearance(appearance, chrome.storage.local);
  return appearance;
}

async function syncAppearance() {
  const result = await chrome.runtime.sendMessage({ type: 'barbarian-appearance' }).catch(() => null);
  return setAppearance(result?.appearance);
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
  return `<div class="transcript">${messages.map((message) => `<div class="message ${message.role === 'user' ? 'user' : 'assistant'}"><span class="message-author">${escapeHtml(message.author)}</span><div class="markdown">${renderMarkdown(message.content)}</div></div>`).join('')}</div>`;
}

function fixedIssuesForReview(review) {
  if (Array.isArray(review.fixed_issues)) return review.fixed_issues;
  return (review.linked_issues || []).map((number) => ({
    provider: 'github', identifier: `#${number}`, url: `https://github.com/${review.repository}/issues/${number}`,
  }));
}

function renderFixedIssues(review) {
  const issues = fixedIssuesForReview(review);
  if (!issues.length) return '';
  const links = issues.map((issue) => issue.url
    ? `<a href="${escapeHtml(issue.url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.identifier)}</a>`
    : `<span>${escapeHtml(issue.identifier)}</span>`).join(', ');
  return `<p class="fixed-issues"><strong>Fixes</strong> ${links}</p>`;
}

function updateSelectionPreview() {
  const preview = document.querySelector('.selection');
  const button = document.querySelector('.ask-selection');
  if (button) button.disabled = busy || !lastSelection;
  if (!preview) return;
  if (!lastSelection) {
    preview.classList.remove('visible');
    preview.textContent = '';
    return;
  }
  const location = lastSelection.path ? ` · ${lastSelection.path}${lastSelection.line ? `:${lastSelection.line}${lastSelection.endLine && lastSelection.endLine !== lastSelection.line ? `-${lastSelection.endLine}` : ''}` : ''}` : '';
  preview.textContent = `${selectionLabel(lastSelection)}${location}`;
  preview.title = lastSelection.text;
  preview.classList.add('visible');
}

function renderContext(context) {
  setAppearance(context.appearance);
  currentContext = context;
  if (context.kind === 'issue') {
    renderIssueContext(context);
    return;
  }
  const main = document.querySelector('main');
  if (!context.review) {
    main.innerHTML = `<div class="untracked-review"><p class="empty">This pull request is not in Barbarian’s review queue.</p><button class="track-review"><span class="button-icon" aria-hidden="true">▶</span><span>Add to queue &amp; review</span></button><p class="action-status"></p></div>`;
    document.querySelector('.track-review')?.addEventListener('click', () => void trackCurrentReview());
    return;
  }
  const { review, assessment, findings = [], messages = [] } = context;
  const summary = pullRequestSummary(review);
  const counts = assessment?.counts || { open: review.findings_count || 0, resolved: 0, outdated: 0, total: review.findings_count || 0 };
  const reviewRunning = review.status === 'agent_working' || Boolean(review.manual_requested_at);
  main.innerHTML = `
    <div class="status ${escapeHtml(assessment?.tone || 'attention')}">${escapeHtml(assessment?.label || 'Needs Review')}</div>
    <section class="review-actions"><h2>Review actions</h2><div class="actions"><button class="agent-review${reviewRunning ? ' running' : ''}" data-running="${reviewRunning}"><span class="button-icon" aria-hidden="true">${reviewRunning ? '■' : '▶'}</span><span>${reviewRunning ? 'Stop agent review' : 'Agent review'}</span></button><button class="secondary test-locally">Test locally</button></div><p class="action-status"></p>${review.workspace_path ? `<code class="workspace-path">${escapeHtml(review.workspace_path)}</code>` : ''}</section>
    <section><h2>Summary</h2><p class="summary">${escapeHtml(summary)}</p>${renderFixedIssues(review)}</section>
    <section class="findings-panel"><h2>Findings</h2><div class="assessment"><p class="assessment-message">${escapeHtml(assessment?.message || 'Waiting for an AI review.')}</p>${assessment?.stale ? '<p class="stale">⚠ This assessment is older than the latest commit.</p>' : ''}<div class="counts"><div class="count"><strong>${Number(counts.open) || 0}</strong><span>Open</span></div><div class="count"><strong>${Number(counts.resolved) || 0}</strong><span>Resolved</span></div><div class="count"><strong>${Number(counts.outdated) || 0}</strong><span>Outdated</span></div><div class="count"><strong>${Number(counts.total) || 0}</strong><span>Total</span></div></div></div>${renderFindings(findings)}</section>
    <section class="review-room"><h2>Review Room</h2><div class="conversation">${renderMessages(messages)}<div class="reply"><span class="reply-label">AGENT REPLY</span><div class="reply-text"></div></div></div><p class="selection"></p><textarea placeholder="Ask what changed, why it works, what could break, or how to test it…"></textarea><div class="actions"><button class="secondary ask-selection" disabled>Ask about selection</button></div><p class="error"></p></section>`;
  document.querySelector('.ask-selection')?.addEventListener('click', () => void sendQuestion('selection'));
  document.querySelector('textarea')?.addEventListener('keydown', (event) => {
    if (!shouldSubmitQuestion(event.key, event.shiftKey, event.isComposing)) return;
    event.preventDefault();
    void sendQuestion('pr');
  });
  document.querySelector('.agent-review')?.addEventListener('click', () => void runReviewAction('review'));
  document.querySelector('.test-locally')?.addEventListener('click', () => void runReviewAction('workspace'));
  document.querySelectorAll('[data-github-url]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    if (currentTab?.id) void chrome.tabs.update(currentTab.id, { url: link.href });
  }));
  updateSelectionPreview();
  void captureSelection();
}

async function trackCurrentReview() {
  if (busy || currentContext?.review || !currentContext?.id) return;
  const button = document.querySelector('.track-review');
  const status = document.querySelector('.action-status');
  busy = true;
  button.disabled = true;
  button.querySelector('span:last-child').textContent = 'Adding…';
  status.textContent = 'Fetching the pull request and starting an agent review…';
  status.classList.remove('error');
  try {
    await api(`/api/reviews/${encodeURIComponent(currentContext.id)}/track`, {
      method: 'POST', body: '{}',
    });
    status.textContent = 'Added. The review agent is starting…';
    await refresh({ quiet: true });
  } catch (caught) {
    status.textContent = caught.message;
    status.classList.add('error');
    button.disabled = false;
    button.querySelector('span:last-child').textContent = 'Add to queue & review';
  } finally {
    busy = false;
  }
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
    updateSelectionPreview();
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
  lastSelection = selection?.text ? selection : undefined;
  updateSelectionPreview();
  return lastSelection;
}

async function sendQuestion(kind) {
  if (busy || (!currentContext?.review && !currentContext?.issue)) return;
  const input = document.querySelector('textarea');
  const error = document.querySelector('.error');
  const reply = document.querySelector('.reply');
  const replyText = document.querySelector('.reply-text');
  const question = input?.value.trim() || '';
  if (kind === 'selection') await captureSelection();
  if ((kind === 'pr' || kind === 'issue') && !question) { error.textContent = 'Write a question first.'; input?.focus(); return; }
  if (kind === 'selection' && !lastSelection) { error.textContent = 'Select lines on the GitHub page first.'; return; }
  const selectionContext = kind === 'selection' ? selectionPromptContext(lastSelection) : '';
  const message = `${question || 'Explain this selected code and how it relates to the pull request.'}${selectionContext}`;
  busy = true;
  error.textContent = 'Agent is thinking…';
  reply?.classList.remove('visible');
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const chatPath = currentContext.issue
      ? `/api/issues/${encodeURIComponent(currentContext.id)}/chat`
      : `/api/reviews/${encodeURIComponent(currentContext.review.id)}/chat`;
    const result = await api(chatPath, {
      method: 'POST', body: JSON.stringify({ message, askAgent: true, author: 'GitHub extension' }),
    });
    if (input) input.value = '';
    if (replyText) replyText.innerHTML = renderMarkdown(result.message?.content || 'The response was saved in Barbarian.');
    reply?.classList.add('visible');
    error.textContent = '';
  } catch (caught) { error.textContent = caught.message; }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    updateSelectionPreview();
  }
}

async function refresh({ quiet = false, remote = false } = {}) {
  if (busy) return;
  const tab = await activeTab();
  const page = parseGitHubPage(tab?.url);
  currentTab = tab;
  if (!page) {
    currentPageKey = '';
    currentPageKind = '';
    currentContext = undefined;
    document.querySelector('.pr-key').textContent = 'GitHub';
    document.querySelector('main').innerHTML = '<p class="empty">Open a GitHub pull request or issue to use Barbarian.</p>';
    return;
  }
  if (page.key !== currentPageKey || page.kind !== currentPageKind) {
    currentPageKey = page.key;
    currentPageKind = page.kind;
    currentContext = undefined;
    lastSelection = undefined;
  }
  document.querySelector('.pr-key').textContent = page.key;
  try {
    const refreshQuery = remote ? '&refresh=1' : '';
    const endpoint = page.kind === 'issue' ? '/api/browser/issue-context' : '/api/browser/context';
    renderContext(await api(`${endpoint}?url=${encodeURIComponent(tab.url)}${refreshQuery}`));
  } catch (caught) {
    if (quiet && currentContext) return;
    document.querySelector('main').innerHTML = `<p class="offline"><strong>Barbarian is offline.</strong>${escapeHtml(caught.message)}</p><p class="empty">Start the local server and this panel will reconnect automatically.</p>`;
  }
}

chrome.tabs.onActivated.addListener(() => {
  void syncAppearance();
  void refresh({ remote: true });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId === currentTab?.id && (change.url || change.status === 'complete')) void refresh();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'barbarian-context-updated' && message.key === currentPageKey
    && message.kind === currentPageKind && message.context) {
    renderContext(message.context);
  } else if (message?.type === 'barbarian-selection-changed' && parseGitHubPage(message.url)?.key === currentPageKey) {
    lastSelection = message.selection?.text ? message.selection : undefined;
    updateSelectionPreview();
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  const appearance = changes[appearanceStorageKey]?.newValue;
  if (areaName === 'local' && appearance) applyAppearance(appearance);
});
setInterval(() => { if (!document.hidden && !busy && !document.querySelector('textarea')?.value) void refresh({ quiet: true }); }, 30_000);
void (async () => {
  const restored = await restoreAppearance(chrome.storage.local);
  const synced = await syncAppearance();
  if (!restored && !synced) applyAppearance(undefined);
  await refresh({ remote: true });
})();
