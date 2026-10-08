import { renderMarkdown } from './markdown.js';
import { formatTimelineTime } from './timeline.js';

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character]);

export function renderReviewRounds(rounds = []) {
  return rounds.map((round, index) => {
    const outcome = round.findings == null
      ? (round.status === 'complete' ? 'Completed' : round.status)
      : round.findings === 0 ? 'No issues found' : `${round.findings} ${round.findings === 1 ? 'issue' : 'issues'} found`;
    const metadata = [formatTimelineTime(round.completed_at), round.provider, round.model, round.effort, round.head_sha?.slice(0, 8)].filter(Boolean).join(' · ');
    return `<details class="review-round" ${index === 0 ? 'open' : ''}>
      <summary>Round ${rounds.length - index} · ${escapeHtml(outcome)}${round.outdated ? ' · Earlier commit' : ''}</summary>
      <p class="round-meta">${escapeHtml(metadata)}</p>
      ${round.delivery ? `<p class="round-meta">${escapeHtml(round.delivery)}</p>` : ''}
      ${round.summary ? `<div class="markdown">${renderMarkdown(round.summary)}</div>` : ''}
      ${round.error ? `<p class="round-error">${escapeHtml(round.error)}</p>` : ''}
      ${round.findings == null && round.status === 'complete' && !round.summary ? '<p class="round-meta">No result was retained for this older round.</p>' : ''}
      ${(round.comments || []).map((comment) => `<details class="round-finding" open><summary>${escapeHtml(comment.summary)}</summary><p class="round-meta"><a href="${escapeHtml(comment.url)}" data-github-url>${escapeHtml(comment.path)}:${escapeHtml(comment.line)}</a></p><div class="markdown">${renderMarkdown(comment.body)}</div></details>`).join('')}
    </details>`;
  }).join('');
}
