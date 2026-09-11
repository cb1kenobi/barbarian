const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character]);

export function formatTimelineTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || '');
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function agentMarkup(agent) {
  const effort = agent.effort === 'CLI default' ? 'default effort' : `${agent.effort} effort`;
  const output = agent.output || (agent.status === 'running'
    ? 'Agent is still running…'
    : 'No output was retained for this run.');
  return `<span class="timeline-run"><span class="timeline-run-heading"><strong>${escapeHtml(agent.provider)}</strong><span>${escapeHtml(agent.status)}</span></span><span>${escapeHtml(agent.model)} · ${escapeHtml(effort)}</span>${agent.error ? `<span class="timeline-run-error">${escapeHtml(agent.error)}</span>` : ''}<pre>${escapeHtml(output)}</pre></span>`;
}

export function renderTimeline(timeline = []) {
  if (!timeline.length) return '<p class="timeline-empty">No timeline events have been recorded for this PR yet.</p>';
  return `<ol>${timeline.map((event) => {
    const outcome = event.outcome
      ? `<span class="timeline-outcome"><strong>${event.outcome.verdict === 'ready' ? 'Ready' : `${Number(event.outcome.findings) || 0} ${Number(event.outcome.findings) === 1 ? 'finding' : 'findings'}`}</strong>${event.outcome.summary ? `<span>${escapeHtml(event.outcome.summary)}</span>` : ''}</span>`
      : '';
    const details = [...(event.agents || [])].map(agentMarkup).join('');
    const label = details || outcome
      ? `<span class="timeline-agent" tabindex="0">${escapeHtml(event.label)}<span class="timeline-agent-tooltip" role="tooltip">${outcome}${details}</span></span>`
      : `<span>${escapeHtml(event.label)}</span>`;
    const exactTime = new Date(event.created_at);
    const title = Number.isNaN(exactTime.getTime()) ? event.created_at : exactTime.toLocaleString();
    return `<li><time title="${escapeHtml(title)}">${escapeHtml(formatTimelineTime(event.created_at))}</time>${label}</li>`;
  }).join('')}</ol>`;
}
