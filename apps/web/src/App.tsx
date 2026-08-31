import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

interface WorkItem {
  id: string; repository: string; number: number; title: string; simple_summary: string;
  priority: number; priority_reasons: string[]; status: string; milestone: string | null;
  duplicate_of: string | null; in_progress_pr: string | null; fixed_by: string | null; url: string;
}

interface Review {
  id: string; repository: string; number: number; title: string; simple_summary: string;
  author: string; url: string; status: string; review_decision: string | null;
  findings_count: number; review_skill: string; workspace_path: string | null; updated_at: string;
}

interface ChatMessage { id: number; role: string; author: string; content: string; created_at: string }

interface Dashboard {
  profile: { name: string; timezone: string };
  monitor: { intervalMinutes: number };
  workQueue: WorkItem[];
  reviews: Review[];
  metrics: { needsAttention: number; agentWorking: number; waiting: number; previousWorkday: Record<string, number> };
  statusDraft: { workday: string; previousWorkday: string; lines: string[]; stats: Record<string, number> };
  statusDue: boolean;
  lastSync: { status: string; finished_at: string | null; error: string | null } | null;
}

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(body.error || response.statusText);
  }
  return response.json() as Promise<T>;
};

function repositoryName(repository: string): string { return repository.split('/').at(-1) || repository; }
function statusLabel(status: string): string {
  return ({ unreviewed: 'Needs review', agent_working: 'Agent reviewing', issues_found: 'Issues found', awaiting_feedback: 'Waiting on author', ready_to_merge: 'Ready to merge', approved: 'Approved' } as Record<string, string>)[status] || status.replaceAll('_', ' ');
}
function statusTone(status: string): string {
  if (status === 'agent_working') return 'working';
  if (status === 'issues_found' || status === 'awaiting_feedback') return 'feedback';
  if (status === 'ready_to_merge' || status === 'approved') return 'ready';
  return 'quiet';
}
function lastWorkdayTotal(stats: Record<string, number>): number {
  return (stats.pr_created || 0) + (stats.review_completed || 0) + (stats.issue_created || 0) + (stats.issue_resolved || 0);
}

export function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [selectedReview, setSelectedReview] = useState<string | null>(null);
  const [showStatus, setShowStatus] = useState(false);

  const load = useCallback(async () => {
    try { setDashboard(await api<Dashboard>('/api/dashboard')); setError(''); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  }, []);

  useEffect(() => { void load(); const interval = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(interval); }, [load]);
  const sync = async () => {
    setSyncing(true);
    try { await api('/api/sync', { method: 'POST' }); await load(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { setSyncing(false); }
  };

  const reviews = dashboard?.reviews || [];
  const queuedWork = (dashboard?.workQueue || []).filter((item) => item.status === 'queued');
  const guardedWork = (dashboard?.workQueue || []).filter((item) => item.status !== 'queued');
  const hasPlan = Boolean(dashboard?.statusDraft.lines.length);
  const name = dashboard?.profile.name?.split(' ')[0] || 'Developer';
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand"><span>B</span><strong>BARBARIAN</strong></div>
        <nav aria-label="Primary">
          <a className="active" href="#command"><i>⌁</i> Command</a>
          <a href="#work"><i>◫</i> Work queue <b>{queuedWork.length}</b></a>
          <a href="#reviews"><i>◇</i> Reviews <b>{reviews.length}</b></a>
          <a href="#activity"><i>↗</i> Activity</a>
        </nav>
        <div className="rail-bottom">
          <div className="sync-dot"><span className={error ? 'bad' : ''} />{error ? 'Server offline' : 'Monitoring active'}</div>
          <small>Every {dashboard?.monitor.intervalMinutes || 20} minutes</small>
          <a className="settings-link" href="/api/settings" target="_blank">⚙ Settings</a>
        </div>
      </aside>

      <main id="command">
        <header>
          <div>
            <p className="eyebrow">{date}</p>
            <h1>Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}, {name}.</h1>
            <p className="subtitle">{dashboard ? `${dashboard.metrics.needsAttention} things need attention. ${dashboard.metrics.agentWorking ? 'The army is already moving.' : 'Your queue is ready.'}` : 'Connecting to your local command center…'}</p>
          </div>
          <button className="sync" disabled={syncing} onClick={() => void sync()}>↻ <span>{syncing ? 'Syncing…' : 'Sync now'}</span></button>
        </header>

        {error && <div className="error-banner"><strong>Barbarian server is not reachable.</strong><span>{error}</span></div>}

        <section className="briefing">
          <div className="brief-copy"><span className="section-label">TODAY’S MARCHING ORDERS</span><h2>{hasPlan ? 'Here’s what you’re doing today' : 'Your watch list needs attention'}</h2><p>{hasPlan ? 'Barbarian assembled your highest-priority work and the reviews that need real time. Open the plan to trim it or add an appointment before copying your update.' : 'Barbarian cannot plan your day until repositories are configured and synced.'}</p></div>
          <div className="brief-actions"><span>{dashboard?.statusDraft.lines.length || 0} priorities ready</span><button onClick={() => setShowStatus(true)} disabled={!dashboard}>Review today’s plan <b>→</b></button></div>
        </section>

        <div className="metrics" aria-label="Workflow totals">
          <article><strong>{dashboard?.metrics.needsAttention ?? '—'}</strong><span>NEED ATTENTION</span><small>work + reviews</small></article>
          <article><strong>{dashboard?.metrics.agentWorking ?? '—'}</strong><span>AGENT WORKING</span><small className={dashboard?.metrics.agentWorking ? 'live' : ''}>{dashboard?.metrics.agentWorking ? '● active now' : 'idle'}</small></article>
          <article><strong>{dashboard?.metrics.waiting ?? '—'}</strong><span>WAITING ON OTHERS</span><small>feedback or fixes</small></article>
          <article><strong>{dashboard ? lastWorkdayTotal(dashboard.metrics.previousWorkday) : '—'}</strong><span>DONE LAST WORKDAY</span><small>{dashboard?.statusDraft.previousWorkday || 'not synced'}</small></article>
        </div>

        <section id="work" className="panel">
          <div className="panel-head"><div><span className="section-label">YOUR WORK</span><h2>Priority queue</h2></div><span className="panel-note">Duplicates, fixed work, and claimed issues are held back</span></div>
          <div className="rows">
            {queuedWork.slice(0, 8).map((item, index) => <a className="work-row" href={item.url} target="_blank" key={item.id}>
              <span className={`rank ${index === 0 ? 'hot' : index === 1 ? 'warm' : ''}`}>{String(index + 1).padStart(2, '0')}</span>
              <span className="row-body"><span className="repo">{repositoryName(item.repository)} · #{item.number}</span><strong>{item.title}</strong><small>{item.milestone ? `${item.milestone} · ` : ''}{item.priority_reasons.join(' · ') || `priority ${item.priority}`}</small></span><span className="chevron">›</span>
            </a>)}
            {!queuedWork.length && <Empty message="No actionable issues yet. Add repositories to config/barbarian.yaml, then sync." />}
          </div>
          {!!guardedWork.length && <details className="guarded"><summary>{guardedWork.length} issues withheld after safety checks</summary>{guardedWork.map((item) => <a href={item.url} target="_blank" key={item.id}><span>{repositoryName(item.repository)}#{item.number}</span>{item.title}<em>{item.status.replaceAll('_', ' ')}</em></a>)}</details>}
        </section>

        <section id="reviews" className="panel reviews">
          <div className="panel-head"><div><span className="section-label">TEAM REVIEWS</span><h2>Review queue</h2></div><span className="panel-note">Merged and closed PRs disappear automatically</span></div>
          <div className="review-grid">
            {reviews.map((review) => <button className="review-card" key={review.id} onClick={() => setSelectedReview(review.id)}><div><span className="repo">{repositoryName(review.repository)}</span><span className="pr">#{review.number}</span></div><h3>{review.title}</h3><p>{review.simple_summary}</p><footer><span className={`tag ${statusTone(review.status)}`}>{statusLabel(review.status)}</span><small>{review.author}</small><i>→</i></footer></button>)}
            {!reviews.length && <Empty message="No pull requests currently need your review." />}
          </div>
        </section>
      </main>

      {selectedReview && <ReviewDrawer id={selectedReview} onClose={() => setSelectedReview(null)} onChanged={load} />}
      {showStatus && dashboard && <StatusDialog dashboard={dashboard} onClose={() => setShowStatus(false)} onSaved={load} />}
    </div>
  );
}

function Empty({ message }: { message: string }) { return <div className="empty"><span>∅</span><p>{message}</p></div>; }

function ReviewDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [review, setReview] = useState<Review | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => { const detail = await api<{ review: Review; messages: ChatMessage[] }>(`/api/reviews/${encodeURIComponent(id)}`); setReview(detail.review); setMessages(detail.messages); }, [id]);
  useEffect(() => { void load(); }, [load]);
  const action = async (name: string, operation: () => Promise<unknown>) => { setBusy(name); setError(''); try { await operation(); await load(); await onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(''); } };
  const send = async (event: FormEvent) => { event.preventDefault(); if (!message.trim()) return; const text = message; setMessage(''); await action('chat', () => api(`/api/reviews/${encodeURIComponent(id)}/chat`, { method: 'POST', body: JSON.stringify({ message: text }) })); };

  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><button className="drawer-close" onClick={onClose}>×</button>
    {!review ? <p>Loading review…</p> : <><span className="section-label">{review.repository} · #{review.number}</span><h2>{review.title}</h2><p className="plain-summary">In plain English: {review.simple_summary}</p>
      <div className="drawer-status"><span className={`tag ${statusTone(review.status)}`}>{statusLabel(review.status)}</span><span>{review.findings_count} blocking issues</span><span>{review.review_skill}</span></div>
      <div className="drawer-actions"><button disabled={!!busy} onClick={() => void action('review', () => api(`/api/reviews/${encodeURIComponent(id)}/run-review`, { method: 'POST', body: '{}' }))}>{busy === 'review' ? 'Starting…' : 'Send review agent'}</button><button disabled={!!busy} onClick={() => void action('workspace', () => api(`/api/reviews/${encodeURIComponent(id)}/workspace`, { method: 'POST', body: '{}' }))}>{busy === 'workspace' ? 'Cloning & building…' : review.workspace_path ? 'Rebuild workspace' : 'Prepare locally'}</button>{review.workspace_path && <button className="muted-button" disabled={!!busy} onClick={() => void action('cleanup', () => api(`/api/reviews/${encodeURIComponent(id)}/workspace`, { method: 'DELETE' }))}>Clean up</button>}<a href={review.url} target="_blank">Open GitHub ↗</a></div>
      {review.workspace_path && <code className="workspace-path">{review.workspace_path}</code>}{error && <p className="inline-error">{error}</p>}
      <div className="chat-head"><div><span className="section-label">REVIEW ROOM</span><h3>Talk it through</h3></div><small>History stays on this machine</small></div><div className="chat-log">{!messages.length && <p className="chat-empty">Ask what changed, why it matters, what could break, or how to test it.</p>}{messages.map((entry) => <div className={`message ${entry.role}`} key={entry.id}><span>{entry.author}</span><p>{entry.content}</p></div>)}{busy === 'chat' && <div className="message assistant"><span>agent</span><p className="typing">Thinking…</p></div>}</div>
      <form className="chat-form" onSubmit={(event) => void send(event)}><textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask about this pull request…" /><button disabled={!!busy || !message.trim()}>Send ↑</button></form>
    </>}
  </aside></div>;
}

function StatusDialog({ dashboard, onClose, onSaved }: { dashboard: Dashboard; onClose: () => void; onSaved: () => Promise<void> }) {
  const initial = useMemo(() => dashboard.statusDraft.lines.join('\n'), [dashboard.statusDraft.lines]);
  const [content, setContent] = useState(initial); const [personalNote, setPersonalNote] = useState(''); const [saved, setSaved] = useState(false);
  const save = async (copy: boolean) => { const final = [content, personalNote].filter(Boolean).join('\n'); await api('/api/status/today', { method: 'PUT', body: JSON.stringify({ content, personalNote, copied: copy }) }); if (copy) await navigator.clipboard.writeText(final); setSaved(true); await onSaved(); if (copy) window.setTimeout(onClose, 600); };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="status-modal" onMouseDown={(event) => event.stopPropagation()}><button className="drawer-close" onClick={onClose}>×</button><span className="section-label">TODAY’S PLAN · {dashboard.statusDraft.workday}</span><h2>Here’s what you’re doing today.</h2><p>Barbarian assembled this from your live priorities and review queue. You only need to correct it or add personal schedule details.</p><label>Today’s marching orders<textarea value={content} onChange={(event) => setContent(event.target.value)} rows={8} /></label><label>Optional schedule note<input value={personalNote} onChange={(event) => setPersonalNote(event.target.value)} placeholder="Out at 3:00 for an appointment" /></label><div className="status-stats"><span>Previous workday</span><b>{dashboard.metrics.previousWorkday.review_completed || 0} reviews</b><b>{dashboard.metrics.previousWorkday.issue_resolved || 0} issues resolved</b><b>{dashboard.metrics.previousWorkday.pr_created || 0} PRs created</b></div><footer><button className="muted-button" onClick={() => void save(false)}>Save changes</button><button onClick={() => void save(true)}>{saved ? 'Copied!' : 'Copy status update'}</button></footer></section></div>;
}
