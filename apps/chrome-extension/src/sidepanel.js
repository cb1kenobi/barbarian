import {
  appearanceStorageKey, applyAppearance, rememberAppearance, restoreAppearance,
} from './appearance.js';
import { pullRequestSummary, reviewRoundCount } from './review-content.js';
import { renderMarkdown } from './markdown.js';
import { shouldSubmitQuestion } from './chat-input.js';
import { chatDraftKey, createChatDrafts } from './chat-drafts.js';
import { selectionLabel, selectionPayload } from './selection-context.js';
import {
  rememberSuppressResolved, restoreSuppressResolved, suppressResolvedStorageKey, visibleFindings,
} from './finding-visibility.js';
import { serverUrlStorageKey } from './connection.js';
import { captureChatScroll, restoredChatScrollTop, shouldKeepChatPinned } from './chat-scroll.js';
import { reconcileChatReply, renderChatPendingMessage } from './chat-pending.js';
import { renderTimeline } from './timeline.js';
import { renderReviewRounds } from './review-findings.js';
import { createFindingExpansion } from './finding-expansion.js';

let currentTab;
let currentPageKey = '';
let currentPageKind = '';
let currentContext;
let busy = false;
let chatPending = false;
let lastSelection;
let suppressResolvedFindings = false;
let activeReviewTab = 'review-room';
let currentDraftKey = '';
let refreshVersion = 0;
let refreshRequested = false;
const chatDrafts = createChatDrafts(chrome.storage.local);
const findingExpansion = createFindingExpansion(chrome.storage.local);

function rememberFindingDetails(root = document) {
  root.querySelectorAll('details[data-finding-detail]').forEach((detail) => {
    if (detail.dataset.findingPr) void findingExpansion.remember(detail.dataset.findingPr, detail.dataset.findingDetail, detail.open);
  });
}

function wireFindingDetails(root = document) {
  const pr = currentPageKey;
  root.querySelectorAll('details[data-finding-detail]').forEach((detail) => {
    detail.dataset.findingPr = pr;
    detail.open = findingExpansion.isOpen(pr, detail.dataset.findingDetail, detail.open);
    detail.addEventListener('toggle', () => {
      if (detail.isConnected) void findingExpansion.remember(pr, detail.dataset.findingDetail, detail.open);
    });
  });
}

function draftSaveError(key) {
  if (key !== currentDraftKey) return;
  const error = document.querySelector('.error');
  if (error) error.textContent = 'Could not save the draft locally. Keep this panel open until it is sent.';
}

function rememberInput(input) {
  const key = input?.dataset.draftKey;
  if (key) void chatDrafts.set(key, input.value).then((saved) => { if (!saved) draftSaveError(key); });
}

function wireChatInput(kind, previous) {
  const input = document.querySelector('textarea');
  if (!input) return;
  input.dataset.draftKey = currentDraftKey;
  input.value = chatDrafts.snapshot(currentDraftKey).value;
  input.addEventListener('input', () => rememberInput(input));
  input.addEventListener('keydown', (event) => {
    if (!shouldSubmitQuestion(event.key, event.shiftKey, event.isComposing)) return;
    event.preventDefault();
    void sendQuestion(kind);
  });
  if (previous?.key === currentDraftKey && previous.focused) {
    input.focus({ preventScroll: true });
    input.setSelectionRange(previous.start, previous.end, previous.direction);
    input.scrollTop = previous.scrollTop;
  }
}

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
    <section><h2>Summary</h2><div class="summary markdown">${renderMarkdown(issue.simple_summary || issue.title)}</div></section>
    <section><h2>Issue context</h2><dl class="issue-context"><div><dt>Assigned to</dt><dd>${escapeHtml(assignees)}</dd></div><div><dt>Priority</dt><dd>${Number(issue.priority) || 0} · ${escapeHtml(reasons)}</dd></div>${issue.milestone ? `<div><dt>Milestone</dt><dd>${escapeHtml(issue.milestone)}</dd></div>` : ''}${issue.duplicate_of ? `<div><dt>Duplicate of</dt><dd>${escapeHtml(issue.duplicate_of)}</dd></div>` : ''}${issue.in_progress_pr ? `<div><dt>Pull request</dt><dd><a href="${escapeHtml(issue.in_progress_pr)}" data-github-url>In progress</a></dd></div>` : ''}${issue.fixed_by ? `<div><dt>Fixed by</dt><dd><a href="${escapeHtml(issue.fixed_by)}" data-github-url>Merged pull request</a></dd></div>` : ''}</dl></section>
    <section class="review-room"><h2>Issue Room</h2><div class="conversation">${renderMessages(messages, chatPending)}</div><textarea placeholder="Ask about the problem, likely causes, scope, or how to verify a fix…"></textarea><p class="error"></p></section>`;
  wireGitHubLinks();
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
  const visible = visibleFindings(findings, suppressResolvedFindings);
  const hidden = findings.length - visible.length;
  if (!visible.length) return hidden
    ? `<p class="empty">${hidden} resolved ${hidden === 1 ? 'finding is' : 'findings are'} hidden.</p>`
    : '<p class="empty">No review findings yet.</p>';
  return `<div class="findings">${visible.map((finding) => {
    const state = findingState(finding);
    const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ''}` : 'Conversation';
    return `<article class="finding ${state.className}"><details data-finding-detail="${escapeHtml(`finding:${finding.id}`)}" ${!finding.resolved && !finding.outdated ? 'open' : ''}><summary>${escapeHtml(finding.summary || 'Review comment')} · ${escapeHtml(state.label)}</summary><p class="finding-meta">${finding.source === 'local' ? 'Saved in Barbarian · ' : ''}<a href="${escapeHtml(finding.url)}" data-github-url>${escapeHtml(location)}</a> · ${escapeHtml(finding.author)}</p><div class="markdown">${renderMarkdown(finding.body)}</div></details></article>`;
  }).join('')}</div>`;
}

function renderMessage(message) {
  const messageId = message.id === undefined ? '' : ` data-message-id="${escapeHtml(message.id)}"`;
  return `<div class="message ${message.role === 'user' ? 'user' : 'assistant'}"${messageId}><span class="message-author">${escapeHtml(message.author)}</span><div class="markdown">${renderMarkdown(message.content)}</div></div>`;
}

function renderMessages(messages = [], pending = false) {
  if (!messages.length && !pending) return '';
  return `<div class="transcript">${messages.map(renderMessage).join('')}${pending ? renderChatPendingMessage() : ''}</div>`;
}

function wireGitHubLinks(root = document) {
  root.querySelectorAll('[data-github-url]').forEach((link) => link.addEventListener('click', (event) => {
    event.preventDefault();
    if (currentTab?.id) void chrome.tabs.update(currentTab.id, { url: link.href });
  }));
}

function conversationScrollSnapshot() {
  const conversation = document.querySelector('.conversation');
  if (!conversation) return undefined;
  const conversationTop = conversation.getBoundingClientRect().top;
  return {
    ...captureChatScroll(conversation),
    anchors: Array.from(conversation.querySelectorAll('[data-message-id]')).map((message) => ({
      id: message.dataset.messageId,
      top: message.getBoundingClientRect().top - conversationTop,
      bottom: message.getBoundingClientRect().bottom - conversationTop,
    })),
  };
}

function restoreConversationScroll(snapshot) {
  const conversation = document.querySelector('.conversation');
  if (!conversation) return;
  let anchorPosition;
  if (snapshot && !snapshot.pinned) {
    const messages = Array.from(conversation.querySelectorAll('[data-message-id]'));
    const survivingAnchors = snapshot.anchors?.filter((candidate) =>
      messages.some((message) => message.dataset.messageId === candidate.id),
    );
    const anchor = survivingAnchors?.find((candidate) => candidate.bottom > 0) || survivingAnchors?.[0];
    const message = anchor && messages.find((candidate) => candidate.dataset.messageId === anchor.id);
    if (message) {
      anchorPosition = {
        beforeTop: anchor.top,
        afterTop: message.getBoundingClientRect().top - conversation.getBoundingClientRect().top,
      };
    }
  }
  conversation.scrollTop = restoredChatScrollTop(snapshot, conversation, anchorPosition);
  const restoredScrollTop = conversation.scrollTop;
  requestAnimationFrame(() => {
    if (conversation.isConnected
      && shouldKeepChatPinned(snapshot, restoredScrollTop, conversation.scrollTop)) {
      conversation.scrollTop = conversation.scrollHeight;
    }
  });
}

function appendConversationMarkup(markup) {
  const conversation = document.querySelector('.conversation');
  if (!conversation) return;
  const snapshot = captureChatScroll(conversation);
  let transcript = conversation.querySelector('.transcript');
  if (!transcript) {
    transcript = document.createElement('div');
    transcript.className = 'transcript';
    conversation.prepend(transcript);
  }
  transcript.insertAdjacentHTML('beforeend', markup);
  restoreConversationScroll(snapshot);
}

function appendConversationMessage(message) {
  appendConversationMarkup(renderMessage(message));
}

function finishPendingConversation(message) {
  const conversation = document.querySelector('.conversation');
  if (!conversation) return;
  const snapshot = captureChatScroll(conversation);
  conversation.querySelector('.chat-pending')?.remove();
  const reconciled = reconcileChatReply(currentContext?.messages, message);
  if (currentContext && reconciled.existingIndex >= 0) {
    currentContext.messages = reconciled.messages;
    const existing = Array.from(conversation.querySelectorAll('[data-message-id]'))
      .find((entry) => entry.dataset.messageId === String(message.id));
    if (existing) existing.outerHTML = renderMessage(message);
  } else if (reconciled.shouldAppend) {
    let transcript = conversation.querySelector('.transcript');
    if (!transcript) {
      transcript = document.createElement('div');
      transcript.className = 'transcript';
      conversation.prepend(transcript);
    }
    transcript.insertAdjacentHTML('beforeend', renderMessage(message));
  }
  restoreConversationScroll(snapshot);
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
  rememberFindingDetails();
  const sameConversation = currentContext?.id === context.id && currentContext?.kind === context.kind;
  const scrollSnapshot = sameConversation ? conversationScrollSnapshot() : undefined;
  const input = document.querySelector('textarea');
  rememberInput(input);
  const previousInput = input && {
    key: input.dataset.draftKey, focused: document.activeElement === input,
    start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection, scrollTop: input.scrollTop,
  };
  setAppearance(context.appearance);
  currentContext = context;
  if (context.kind === 'issue') {
    renderIssueContext(context);
    wireChatInput('issue', previousInput);
    restoreConversationScroll(scrollSnapshot);
    if (busy) document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    return;
  }
  const main = document.querySelector('main');
  if (!context.review) {
    main.innerHTML = `<div class="untracked-review"><p class="empty">This pull request is not in Barbarian’s review queue.</p><button class="track-review"><span class="button-icon" aria-hidden="true">▶</span><span>Add to queue &amp; review</span></button><p class="action-status"></p></div>`;
    document.querySelector('.track-review')?.addEventListener('click', () => void trackCurrentReview());
    return;
  }
  const { review, assessment, findings = [], rounds = [], messages = [], timeline = [] } = context;
  const summary = pullRequestSummary(review);
  const reviewRounds = reviewRoundCount(review);
  const counts = assessment?.counts || { open: review.findings_count || 0, resolved: 0, outdated: 0, total: review.findings_count || 0 };
  const reviewRunning = review.status === 'agent_working' || Boolean(review.manual_requested_at);
  main.innerHTML = `
    <div class="status ${escapeHtml(assessment?.tone || 'attention')}">${escapeHtml(assessment?.label || 'Needs Review')}</div>
    <section class="review-actions"><h2>Review actions</h2><div class="actions"><button class="agent-review${reviewRunning ? ' running' : ''}" data-running="${reviewRunning}"><span class="button-icon" aria-hidden="true">${reviewRunning ? '■' : '▶'}</span><span>${reviewRunning ? 'Stop agent review' : 'Agent review'}</span></button><button class="secondary test-locally">Test locally</button></div><p class="action-status"></p>${review.workspace_path ? `<code class="workspace-path">${escapeHtml(review.workspace_path)}</code>` : ''}</section>
    <section><h2>Summary</h2><div class="summary markdown">${renderMarkdown(summary)}</div>${renderFixedIssues(review)}<p class="review-rounds" aria-label="${reviewRounds} agent review ${reviewRounds === 1 ? 'round' : 'rounds'}">AI Review Rounds: <strong>${reviewRounds}</strong></p></section>

    <div class="review-tabs" role="tablist" aria-label="Pull request details"><button type="button" role="tab" aria-selected="${activeReviewTab === 'findings'}" class="${activeReviewTab === 'findings' ? 'active' : ''}" data-review-tab="findings">Findings</button><button type="button" role="tab" aria-selected="${activeReviewTab === 'review-room'}" class="${activeReviewTab === 'review-room' ? 'active' : ''}" data-review-tab="review-room">Review Room</button><button type="button" role="tab" aria-selected="${activeReviewTab === 'timeline'}" class="${activeReviewTab === 'timeline' ? 'active' : ''}" data-review-tab="timeline">Timeline</button></div>
    ${activeReviewTab === 'findings'
      ? `<section class="findings-panel" role="tabpanel" aria-label="Findings"><div class="assessment"><p class="assessment-message">${escapeHtml(assessment?.message || 'Waiting for an AI review.')}</p>${assessment?.stale ? '<p class="stale">⚠ This assessment is older than the latest commit.</p>' : ''}<div class="counts"><div class="count"><strong>${Number(counts.open) || 0}</strong><span>Open</span></div><div class="count"><strong>${Number(counts.resolved) || 0}</strong><span>Resolved</span></div><div class="count"><strong>${Number(counts.outdated) || 0}</strong><span>Outdated</span></div><div class="count"><strong>${Number(counts.total) || 0}</strong><span>Total</span></div></div></div>${renderReviewRounds(rounds)}<div class="findings-heading"><h2>${rounds.length ? 'Current PR comments' : 'Findings'}</h2><label class="finding-filter"><input type="checkbox" ${suppressResolvedFindings ? 'checked' : ''}> Hide resolved</label></div><div class="findings-content">${renderFindings(findings)}</div></section>`
      : activeReviewTab === 'review-room'
      ? `<section class="review-room" role="tabpanel"><div class="conversation">${renderMessages(messages, chatPending)}</div><p class="selection"></p><textarea placeholder="Ask what changed, why it works, what could break, or how to test it…"></textarea><div class="actions"><button class="secondary ask-selection" disabled>Ask about selection</button></div><p class="error"></p></section>`
      : `<section class="review-timeline" role="tabpanel">${renderTimeline(timeline)}</section>`}`;
  document.querySelectorAll('[data-review-tab]').forEach((button) => button.addEventListener('click', () => {
    activeReviewTab = button.dataset.reviewTab;
    renderContext(currentContext);
  }));
  document.querySelector('.ask-selection')?.addEventListener('click', () => void sendQuestion('selection'));
  wireChatInput('pr', previousInput);
  document.querySelector('.agent-review')?.addEventListener('click', () => void runReviewAction('review'));
  document.querySelector('.test-locally')?.addEventListener('click', () => void runReviewAction('workspace'));
  document.querySelector('.finding-filter input')?.addEventListener('change', (event) => {
    suppressResolvedFindings = event.currentTarget.checked;
    void rememberSuppressResolved(suppressResolvedFindings, chrome.storage.local);
    const content = document.querySelector('.findings-content');
    if (content) {
      rememberFindingDetails(content);
      content.innerHTML = renderFindings(findings);
      wireGitHubLinks(content);
      wireFindingDetails(content);
    }
  });
  wireGitHubLinks();
  wireFindingDetails();
  updateSelectionPreview();
  restoreConversationScroll(scrollSnapshot);
  if (busy) document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
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
    const result = await api(`/api/reviews/${encodeURIComponent(currentContext.id)}/track`, {
      method: 'POST', body: '{}',
    });
    status.textContent = result.reviewStarted === false
      ? 'Added. No code review agents are configured.'
      : 'Added. The review agent is starting…';
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
    ? stoppingReview ? 'Stopping this PR review and pausing automatic reviews…' : 'Starting the review agent…'
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
            ? 'Stopped this PR review. Automatic reviews are paused until you start another review.'
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
        status.textContent = 'Agent review started. Click stop to cancel this review and pause automatic reviews.';
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
  const context = currentContext;
  const draftKey = currentDraftKey;
  if (kind === 'selection') await captureSelection();
  if (draftKey !== currentDraftKey || context !== currentContext || busy) return;
  rememberInput(input);
  const sentDraft = chatDrafts.snapshot(draftKey);
  const question = input?.value.trim() || '';
  if ((kind === 'pr' || kind === 'issue') && !question) { error.textContent = 'Write a question first.'; input?.focus(); return; }
  if (kind === 'selection' && !lastSelection) { error.textContent = 'Select lines on the GitHub page first.'; return; }
  const message = question || 'Explain this selected code and how it relates to the pull request.';
  const selection = kind === 'selection' ? selectionPayload(lastSelection) : undefined;
  const cleared = chatDrafts.clearIfUnchanged(draftKey, sentDraft);
  const clearedDraft = chatDrafts.snapshot(draftKey);
  if (input) input.value = '';
  void cleared.then((saved) => { if (!saved) draftSaveError(draftKey); });
  appendConversationMessage({ role: 'user', author: 'GitHub extension', content: message });
  busy = true;
  chatPending = true;
  appendConversationMarkup(renderChatPendingMessage());
  error.textContent = '';
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try {
    const chatPath = context.issue
      ? `/api/issues/${encodeURIComponent(context.id)}/chat`
      : `/api/reviews/${encodeURIComponent(context.review.id)}/chat`;
    const result = await api(chatPath, {
      method: 'POST', body: JSON.stringify({ message, selection, askAgent: true, author: 'GitHub extension' }),
    });
    chatPending = false;
    finishPendingConversation(result.message || {
      role: 'assistant', author: 'Agent', content: 'The response was saved in Barbarian.',
    });
    const currentError = document.querySelector('.error');
    if (currentError) currentError.textContent = '';
  } catch (caught) {
    // Restore a failed submission only if the composer has not been edited since.
    if (chatDrafts.snapshot(draftKey) === clearedDraft) {
      void chatDrafts.set(draftKey, sentDraft.value).then((saved) => { if (!saved) draftSaveError(draftKey); });
      const currentInput = document.querySelector('textarea');
      if (currentInput?.dataset.draftKey === draftKey) currentInput.value = sentDraft.value;
    }
    chatPending = false;
    finishPendingConversation();
    const currentError = document.querySelector('.error');
    if (currentError) currentError.textContent = caught.message;
  }
  finally {
    chatPending = false;
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    updateSelectionPreview();
    if (refreshRequested) void refresh({ quiet: true });
  }
}

async function refresh({ quiet = false, remote = false } = {}) {
  if (busy) { refreshRequested = true; return; }
  refreshRequested = false;
  const version = ++refreshVersion;
  const tab = await activeTab();
  if (version !== refreshVersion || busy) return;
  const page = parseGitHubPage(tab?.url);
  currentTab = tab;
  rememberFindingDetails();
  rememberInput(document.querySelector('textarea'));
  if (!page) {
    currentPageKey = '';
    currentPageKind = '';
    currentDraftKey = '';
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
    activeReviewTab = 'review-room';
  }
  document.querySelector('.pr-key').textContent = page.key;
  currentDraftKey = chatDraftKey(page.kind, page.key);
  try {
    await Promise.all([chatDrafts.load(currentDraftKey), findingExpansion.load(page.key)]);
  } catch {
    if (version !== refreshVersion || busy) return;
    document.querySelector('main').innerHTML = '<p class="offline">Could not load the saved chat draft. This panel will retry automatically.</p>';
    return;
  }
  if (version !== refreshVersion || busy) return;
  try {
    const refreshQuery = remote ? '&refresh=1' : '';
    const endpoint = page.kind === 'issue' ? '/api/browser/issue-context' : '/api/browser/context';
    const context = await api(`${endpoint}?url=${encodeURIComponent(tab.url)}${refreshQuery}`);
    if (version !== refreshVersion || busy) return;
    renderContext(context);
  } catch (caught) {
    if (version !== refreshVersion || busy) return;
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
    const draftKey = currentDraftKey;
    const version = refreshVersion;
    void Promise.all([chatDrafts.load(draftKey), findingExpansion.load(currentPageKey)]).then(() => {
      if (draftKey === currentDraftKey && version === refreshVersion) renderContext(message.context);
    }).catch(() => draftSaveError(draftKey));
  } else if (message?.type === 'barbarian-selection-changed' && parseGitHubPage(message.url)?.key === currentPageKey) {
    lastSelection = message.selection?.text ? message.selection : undefined;
    updateSelectionPreview();
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  const appearance = changes[appearanceStorageKey]?.newValue;
  if (areaName === 'local' && appearance) applyAppearance(appearance);
  if (areaName === 'local' && suppressResolvedStorageKey in changes) {
    suppressResolvedFindings = changes[suppressResolvedStorageKey].newValue === true;
    const checkbox = document.querySelector('.finding-filter input');
    if (checkbox) checkbox.checked = suppressResolvedFindings;
    const content = document.querySelector('.findings-content');
    if (content && currentContext?.findings) {
      rememberFindingDetails(content);
      content.innerHTML = renderFindings(currentContext.findings);
      wireGitHubLinks(content);
      wireFindingDetails(content);
    }
  }
  if (areaName === 'local' && serverUrlStorageKey in changes) {
    const dashboard = document.querySelector('.dashboard');
    if (dashboard && changes[serverUrlStorageKey].newValue) {
      dashboard.href = `${changes[serverUrlStorageKey].newValue}/#reviews`;
    }
  }
});
setInterval(() => { if (!document.hidden && !busy && !document.querySelector('textarea')?.value) void refresh({ quiet: true }); }, 30_000);
void (async () => {
  const connection = await chrome.runtime.sendMessage({ type: 'barbarian-connection' }).catch(() => null);
  const dashboard = document.querySelector('.dashboard');
  if (dashboard && connection?.serverUrl) dashboard.href = `${connection.serverUrl}/#reviews`;
  suppressResolvedFindings = await restoreSuppressResolved(chrome.storage.local);
  const restored = await restoreAppearance(chrome.storage.local);
  const synced = await syncAppearance();
  if (!restored && !synced) applyAppearance(undefined);
  await refresh({ remote: true });
})();
