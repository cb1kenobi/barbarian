import { useCallback, useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from 'react';
import { formatLastSync, formatNextSync, formatSyncTimestamp, type SyncRun } from './sync-time';
import { sortReviews, type ReviewSort } from './review-sort';
import { countReviewsNeedingApproval, reviewDisplayStatus, reviewStatusGuide, statusLabel, statusTone } from './review-display';
import { formatElapsed } from './elapsed-time';
import { applyAppearance, SettingsModal, type AppearanceConfig } from './settings';
import { editStatusText } from './status-editor';
import { shouldSubmitChat } from './chat-editor';
import { renderMarkdown } from './markdown';
import { repositoryBookmark, sortRepositoryBookmarks, type RepositoryBookmark } from './repository-links';
import { sortWorkItems, type WorkSort } from './work-sort';
import { matchesQueueSearch } from './queue-search';

interface WorkItem {
  id: string; repository: string; number: number; title: string; simple_summary: string;
  priority: number; priority_reasons: string[]; status: string; milestone: string | null;
  duplicate_of: string | null; in_progress_pr: string | null; fixed_by: string | null; url: string;
  assignees: string[]; in_progress: boolean; in_progress_source: string | null;
  in_progress_branch: string | null; updated_at: string;
}

interface Review {
  id: string; repository: string; number: number; title: string; simple_summary: string;
  author: string; url: string; status: string; review_decision: string | null;
  additions: number; deletions: number;
  findings_count: number; review_skill: string; workspace_path: string | null; updated_at: string;
  pending_reason: string | null; display_status?: string; priority_score: number;
  remote_created_at: string; remote_updated_at: string; last_agent_review_at: string | null;
  new_commit_count: number;
  issue_counts: { high: number; medium: number; low: number };
  linked_issues?: number[];
  fixed_issues?: FixedIssueReference[];
}

interface FixedIssueReference {
  provider: 'github' | 'linear';
  identifier: string;
  url: string | null;
}

interface ChatMessage { id: number; role: string; author: string; content: string; created_at: string }

interface ActiveReview {
  id: string; repository: string; number: number; title: string; url: string;
  agent: string; model: string; effort: string; started_at: string;
}

interface Dashboard {
  profile: { name: string; reviewName: string; timezone: string; githubLogin: string };
  appearance: AppearanceConfig;
  monitor: { intervalMinutes: number; nextSyncAt: string | null };
  repositories?: RepositoryBookmark[];
  activeReviews: ActiveReview[];
  workQueue: WorkItem[];
  reviews: Review[];
  metrics: {
    needsAttention: number; queuedIssues?: number; reviewsNeedingApproval?: number;
    agentWorking: number; waiting: number; previousWorkday: Record<string, number>;
  };
  statusDraft: { workday: string; previousWorkday: string; lines: string[]; stats: Record<string, number> };
  statusDue: boolean;
  lastSync: SyncRun | null;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const headers = new Headers(options?.headers);
  if (options?.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new ApiError(body.error || response.statusText, response.status);
  }
  return response.json() as Promise<T>;
};

interface AppError { message: string; connection: boolean }
function appError(caught: unknown): AppError {
  return {
    message: caught instanceof Error ? caught.message : String(caught),
    connection: !(caught instanceof ApiError),
  };
}

function repositoryName(repository: string): string { return repository.split('/').at(-1) || repository; }
function issueAssignee(item: WorkItem, githubLogin: string | undefined): { label: string; mine: boolean } {
  if (!item.assignees.length) return { label: 'Unassigned', mine: false };
  const mine = Boolean(githubLogin && item.assignees.some((login) => login.toLowerCase() === githubLogin.toLowerCase()));
  return { label: mine ? 'Assigned to you' : item.assignees.join(', '), mine };
}

function issueProgress(item: WorkItem): string | null {
  if (item.in_progress_source === 'pull_request') {
    const number = item.in_progress_pr?.match(/\/pull\/(\d+)/)?.[1];
    return number ? `In progress · PR #${number}` : 'In progress · linked PR';
  }
  if (item.in_progress_source === 'local_branch') return `In progress · local ${item.in_progress_branch}`;
  if (item.in_progress_source === 'label') return 'In progress · GitHub label';
  if (item.fixed_by) return 'Linked PR merged';
  if (item.duplicate_of) return `Duplicate: ${item.duplicate_of}`;
  return null;
}
function lastWorkdayTotal(stats: Record<string, number>): number {
  return (stats.pr_created || 0) + (stats.review_completed || 0) + (stats.issue_created || 0) + (stats.issue_resolved || 0);
}

function useCloseOnEscape(onClose: () => void): void {
  useEffect(() => {
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
}

export function App() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [selectedReview, setSelectedReview] = useState<string | null>(null);
  const [showStatus, setShowStatus] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [reviewSort, setReviewSort] = useState<ReviewSort>('priority');
  const [reviewRepository, setReviewRepository] = useState('all');
  const [workSort, setWorkSort] = useState<WorkSort>('in-progress');
  const [workRepository, setWorkRepository] = useState('all');
  const [queueSearch, setQueueSearch] = useState('');

  const load = useCallback(async () => {
    try {
      const next = await api<Dashboard>('/api/dashboard');
      if (next.repositories === undefined) {
        try {
          const settings = await api<{ config: { repositories: Array<{ name: string }> } }>('/api/settings');
          next.repositories = settings.config.repositories.map(({ name }) => repositoryBookmark(name));
        } catch {
          const names = new Set([...next.workQueue, ...next.reviews].map(({ repository }) => repository));
          next.repositories = [...names].map(repositoryBookmark);
        }
      }
      setDashboard(next);
      setError(null);
    }
    catch (caught) { setError(appError(caught)); }
  }, []);

  useEffect(() => {
    const refreshVisibleDashboard = () => { if (!document.hidden) void load(); };
    void load();
    const interval = window.setInterval(refreshVisibleDashboard, 5_000);
    window.addEventListener('focus', refreshVisibleDashboard);
    document.addEventListener('visibilitychange', refreshVisibleDashboard);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisibleDashboard);
      document.removeEventListener('visibilitychange', refreshVisibleDashboard);
    };
  }, [load]);
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('review-updated', () => void load());
    events.addEventListener('dashboard-updated', () => void load());
    return () => events.close();
  }, [load]);
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 15_000); return () => window.clearInterval(interval); }, []);
  useEffect(() => {
    if (dashboard?.appearance) applyAppearance(dashboard.appearance);
  }, [dashboard?.appearance.theme, dashboard?.appearance.fontSize]);
  const sync = async () => {
    setSyncing(true);
    try { await api('/api/sync', { method: 'POST' }); await load(); }
    catch (caught) { setError(appError(caught)); }
    finally { setSyncing(false); }
  };

  const allReviews = dashboard?.reviews || [];
  const reviewRepositories = useMemo(() => [...new Set(allReviews.map((review) => review.repository))].sort(), [allReviews]);
  const reviews = useMemo(() => sortReviews(
    allReviews.filter((review) => (reviewRepository === 'all' || review.repository === reviewRepository)
      && matchesQueueSearch(review, queueSearch)),
    reviewSort,
  ), [allReviews, queueSearch, reviewRepository, reviewSort]);
  const repositories = useMemo(() => sortRepositoryBookmarks(dashboard?.repositories || []), [dashboard?.repositories]);
  const visibleReviewsNeedingApproval = countReviewsNeedingApproval(reviews);
  const visibleApprovedReviews = reviews.filter((review) => reviewDisplayStatus(review) === 'approved').length;
  const allWork = dashboard?.workQueue || [];
  const workRepositories = useMemo(() => [...new Set(allWork.map((item) => item.repository))].sort(), [allWork]);
  const visibleWork = useMemo(() => sortWorkItems(
    allWork.filter((item) => (workRepository === 'all' || item.repository === workRepository) && matchesQueueSearch(item, queueSearch)),
    workSort,
  ), [allWork, queueSearch, workRepository, workSort]);
  const queuedIssueCount = dashboard?.metrics.queuedIssues ?? allWork.length;
  const reviewCount = dashboard?.metrics.reviewsNeedingApproval ?? countReviewsNeedingApproval(dashboard?.reviews || []);
  const attentionCount = queuedIssueCount + reviewCount;
  const hasPlan = Boolean(dashboard?.statusDraft.lines.length);
  const name = dashboard?.profile.name?.split(' ')[0] || 'Developer';
  const date = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).format(new Date()).toUpperCase();

  return (
    <div className="shell">
      <aside className="rail">
        <a className="brand" href="#command" aria-label="Scroll to the top"><span aria-hidden="true" /><strong>BARBARIAN</strong></a>
        <nav aria-label="Primary">
          <a href="#reviews"><i>◇</i> Reviews <b>{reviews.length}</b></a>
          <a href="#work"><i>◫</i> Work queue <b>{allWork.length}</b></a>
        </nav>
        <section className="repo-bookmarks" aria-labelledby="repo-bookmarks-label">
          <span className="rail-label" id="repo-bookmarks-label">REPOSITORIES</span>
          <div className="repo-list">
            {repositories.map((repository) => <a href={repository.url} target="_blank" rel="noreferrer" title={repository.name} key={repository.name}><span>{repositoryName(repository.name)}</span><i aria-hidden="true">↗</i></a>)}
            {!repositories.length && <span className="repo-empty">{dashboard ? 'No repositories configured' : 'Waiting for server…'}</span>}
          </div>
          <section className="active-reviews" aria-labelledby="active-reviews-label">
            <span className="rail-label" id="active-reviews-label">ACTIVE CODE REVIEWS</span>
            <div className="active-review-list">
              {(dashboard?.activeReviews || []).map((review) => <a className="active-review" href={review.url} target="_blank" rel="noreferrer" title={review.title} key={review.id}>
                <span className="active-review-head"><span><i aria-hidden="true" />{repositoryName(review.repository)} #{review.number}</span><time>{formatElapsed(review.started_at, now)}</time></span>
                <small>{review.agent} · {review.model} · {review.effort === 'CLI default' ? 'default effort' : `${review.effort} effort`}</small>
              </a>)}
              {dashboard && !dashboard.activeReviews?.length && <span className="active-review-empty">No reviews running</span>}
            </div>
          </section>
        </section>
        <div className="rail-bottom">
          <div className="sync-dot"><span className={error?.connection ? 'bad' : ''} />{error?.connection ? 'Server offline' : 'Monitoring active'}</div>
          <div className="sync-schedule">
            <span title={formatSyncTimestamp(dashboard?.lastSync?.finished_at, dashboard?.profile.timezone)}>{formatLastSync(dashboard?.lastSync || null, now)}</span>
            <span title={syncing ? undefined : formatSyncTimestamp(dashboard?.monitor.nextSyncAt, dashboard?.profile.timezone)}>{syncing ? 'Next sync right now' : dashboard ? formatNextSync(dashboard.monitor.nextSyncAt, now) : 'Waiting for monitor…'}</span>
          </div>
          <div className="rail-actions">
            <button className="sync rail-sync" disabled={syncing} onClick={() => void sync()}><span className="rail-button-icon" aria-hidden="true">↻</span><span className="rail-button-label">{syncing ? 'Syncing…' : 'Sync'}</span></button>
            <button className="sync rail-sync" onClick={() => setShowSettings(true)}><span className="rail-button-icon settings-gear" aria-hidden="true">⚙</span><span className="rail-button-label">Settings</span></button>
          </div>
        </div>
      </aside>

      <main id="command">
        <header className="dashboard-header">
          <div className="dashboard-welcome">
            <p className="eyebrow">{date}</p>
            <h1>Good {new Date().getHours() < 12 ? 'morning' : 'afternoon'}, {name}.</h1>
            <p className="subtitle">{dashboard ? `${queuedIssueCount} issue${queuedIssueCount === 1 ? '' : 's'} on your radar · ${reviewCount} PR${reviewCount === 1 ? '' : 's'} to review.` : 'Connecting to your local command center…'}</p>
          </div>
          <section className="briefing">
            <div className="brief-copy"><span className="section-label">STATUS UPDATE</span><h2>{hasPlan ? 'Your update is ready' : 'Your watch list needs attention'}</h2><p>{hasPlan ? 'Review the Slack-ready list before you publish it.' : 'Barbarian cannot prepare an update until repositories are configured and synced.'}</p></div>
            <div className="brief-actions"><span>{dashboard?.statusDraft.lines.length || 0} items ready</span><button onClick={() => setShowStatus(true)} disabled={!dashboard}>Open status update <b>→</b></button></div>
          </section>
        </header>

        {error && <div className="error-banner"><strong>{error.connection ? 'Barbarian server is not reachable.' : 'Barbarian could not complete that request.'}</strong><span>{error.message}</span></div>}

        <div className="metrics" aria-label="Workflow totals">
          <article><strong>{dashboard ? attentionCount : '—'}</strong><span>ON YOUR RADAR</span><small>{dashboard ? `${queuedIssueCount} issues + ${reviewCount} PRs` : 'issues + reviews'}</small></article>
          <article><strong>{dashboard?.metrics.agentWorking ?? '—'}</strong><span>AGENT WORKING</span><small className={dashboard?.metrics.agentWorking ? 'live' : ''}>{dashboard?.metrics.agentWorking ? '● active now' : 'idle'}</small></article>
          <article><strong>{dashboard?.metrics.waiting ?? '—'}</strong><span>WAITING ON OTHERS</span><small>feedback or fixes</small></article>
          <article><strong>{dashboard ? lastWorkdayTotal(dashboard.metrics.previousWorkday) : '—'}</strong><span>DONE LAST WORKDAY</span><small>{dashboard?.statusDraft.previousWorkday || 'not synced'}</small></article>
        </div>

        <div className="queue-search">
          <label htmlFor="queue-search-input">
            <svg className="queue-search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m12.5 12.5 4 4" /></svg>
            <input id="queue-search-input" type="search" aria-label="Search code reviews and issues" value={queueSearch} onChange={(event) => setQueueSearch(event.target.value)} placeholder="Search reviews and issues by number, title, or description" />
            {queueSearch && <button className="queue-search-clear" type="button" onClick={() => setQueueSearch('')} aria-label="Clear queue search"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>}
          </label>
        </div>

        <section id="reviews" className="panel reviews">
          <div className="panel-head"><div><span className="section-label">CODE REVIEWS</span><div className="review-heading"><h2>Review queue</h2><span className="review-count" aria-label={`${visibleReviewsNeedingApproval} matching non-approved pull requests need your review`}>{visibleReviewsNeedingApproval} to review</span><span className="review-count approved-count" aria-label={`${visibleApprovedReviews} matching pull requests are approved`}>{visibleApprovedReviews} approved</span><ReviewStatusInfo /></div></div><div className="queue-controls">
            <label className="review-sort queue-repository"><span>Repo</span><select value={reviewRepository} onChange={(event) => setReviewRepository(event.target.value)}><option value="all">All repositories</option>{reviewRepositories.map((repository) => <option value={repository} key={repository}>{repositoryName(repository)}</option>)}</select></label>
            <label className="review-sort"><span>Sort</span><select value={reviewSort} onChange={(event) => setReviewSort(event.target.value as ReviewSort)}><option value="priority">Priority</option><option value="pain">Pain</option><option value="oldest">Oldest</option><option value="newest">Newest</option><option value="repository">Repo name</option></select></label>
          </div></div>
          <div className="review-grid queue-viewport review-viewport">
            {reviews.map((review) => <button className="review-card" key={review.id} onClick={() => setSelectedReview(review.id)}>
              <div className="review-card-head"><span><span className="repo">{repositoryName(review.repository)}</span><span className="pr">#{review.number}</span></span><ReviewStatusBadge status={reviewDisplayStatus(review)} /></div>
              <h3>{review.title}</h3><p>{review.simple_summary}</p>
              <footer className="review-card-footer">
                <small className="review-times">
                  <span title={formatSyncTimestamp(review.remote_updated_at, dashboard?.profile.timezone)}>Updated: {formatElapsed(review.remote_updated_at, now)}</span>
                  <span title={formatSyncTimestamp(review.last_agent_review_at, dashboard?.profile.timezone)}>Reviewed: {formatElapsed(review.last_agent_review_at, now)}</span>
                </small>
                <small className="line-counts" aria-label={`${review.additions} lines added and ${review.deletions} lines removed`}>
                  <span className="lines-added">+{review.additions}</span><span className="lines-removed">−{review.deletions}</span>
                </small>
                <span className="review-signals">
                  <SeverityCounts counts={review.issue_counts} />
                  <span className="new-commits" aria-label={`${review.new_commit_count} new ${review.new_commit_count === 1 ? 'commit' : 'commits'} since the last agent review`}>
                    <strong>{review.new_commit_count}</strong> new {review.new_commit_count === 1 ? 'commit' : 'commits'}
                  </span>
                </span>
              </footer>
            </button>)}
            {!reviews.length && <Empty message={queueSearch || reviewRepository !== 'all' ? 'No code reviews match these filters.' : 'No pull requests currently need your review.'} />}
          </div>
        </section>

        <section id="work" className="panel">
          <div className="panel-head"><div><span className="section-label">YOUR WORK</span><div className="review-heading"><h2>Issue queue</h2><span className="review-count" aria-label={`${visibleWork.length} matching issues in the queue`}>{visibleWork.length} issues</span></div></div><div className="queue-controls">
            <label className="review-sort queue-repository"><span>Repo</span><select value={workRepository} onChange={(event) => setWorkRepository(event.target.value)}><option value="all">All repositories</option>{workRepositories.map((repository) => <option value={repository} key={repository}>{repositoryName(repository)}</option>)}</select></label>
            <label className="review-sort"><span>Sort</span><select value={workSort} onChange={(event) => setWorkSort(event.target.value as WorkSort)}><option value="in-progress">In progress</option><option value="priority">Priority</option><option value="updated">Recently updated</option></select></label>
          </div></div>
          <div className="rows queue-viewport issue-viewport">
            {visibleWork.map((item, index) => {
              const assignee = issueAssignee(item, dashboard?.profile.githubLogin);
              const progress = issueProgress(item);
              const details = [progress, item.milestone, `Priority ${item.priority}${item.priority_reasons.length ? `: ${item.priority_reasons.join(' · ')}` : ''}`].filter(Boolean).join(' · ');
              return <a className="work-row" href={item.url} target="_blank" key={item.id}>
                <span className={`rank ${index === 0 ? 'hot' : index === 1 ? 'warm' : ''}`}>{String(index + 1).padStart(2, '0')}</span>
                <span className="row-body"><span className="issue-key"><span className="repo">{repositoryName(item.repository)}</span><span className="issue-number">#{item.number}</span></span><span className="work-title"><strong>{item.title}</strong><span className={`assignee-label ${assignee.mine ? 'mine' : ''}`}>{assignee.label}</span></span><small>{details}</small></span><span className="chevron">›</span>
              </a>;
            })}
            {!visibleWork.length && <Empty message={allWork.length ? (queueSearch ? 'No issues match this search and repository filter.' : 'No issues match this repository filter.') : 'No assigned or unassigned issues are currently open.'} />}
          </div>
        </section>
      </main>

      {selectedReview && <ReviewDrawer id={selectedReview} onClose={() => setSelectedReview(null)} onChanged={load} />}
      {showStatus && dashboard && <StatusDialog dashboard={dashboard} onClose={() => setShowStatus(false)} onSaved={load} />}
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} onSaved={load} />}
    </div>
  );
}

function Empty({ message }: { message: string }) { return <div className="empty"><span>∅</span><p>{message}</p></div>; }

function ReviewStatusInfo() {
  return <span className="status-info" tabIndex={0} aria-label="PR status definitions" aria-describedby="review-status-guide">
    <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5" /><circle cx="10" cy="6.3" r=".7" fill="currentColor" stroke="none" /></svg>
    <span className="status-guide" id="review-status-guide" role="tooltip">
      <strong>PR statuses</strong>
      {reviewStatusGuide.map(({ status, description }) => <span className="status-guide-row" key={status}>
        <ReviewStatusBadge status={status} /><span>{description}</span>
      </span>)}
    </span>
  </span>;
}

function ReviewStatusBadge({ status }: { status: unknown }) {
  return <span className={`tag ${statusTone(status)}`}>
    {status === 'approved' && <svg className="tag-check" viewBox="0 0 12 12" aria-hidden="true"><path d="m1.8 6.2 2.6 2.6 5.8-5.9" /></svg>}
    {statusLabel(status)}
  </span>;
}

function SeverityCounts({ counts }: { counts: Review['issue_counts'] }) {
  const total = counts.high + counts.medium + counts.low;
  return <span className="severity-counts" aria-label={`${counts.high} high, ${counts.medium} medium, and ${counts.low} low severity issues; ${total} total`}>
    <span className="severity high" title={`${counts.high} blocker/high severity`}><SeverityIcon kind="high" />{counts.high}</span>
    <span className="severity medium" title={`${counts.medium} medium severity`}><SeverityIcon kind="medium" />{counts.medium}</span>
    <span className="severity low" title={`${counts.low} low severity/nit`}><SeverityIcon kind="low" />{counts.low}</span>
  </span>;
}

function SeverityIcon({ kind }: { kind: 'high' | 'medium' | 'low' }) {
  if (kind === 'high') return <svg className="severity-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <path d="M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2z" />
    <path d="M8 4.6v4.2M8 11.5h.01" />
  </svg>;
  if (kind === 'medium') return <svg className="severity-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <path d="M8 1.5 14.5 14h-13z" />
    <path d="M8 5.3v4M8 11.7h.01" />
  </svg>;
  return <svg className="severity-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 7v4M8 4.5h.01" />
  </svg>;
}

function fixedIssuesForReview(review: Review): FixedIssueReference[] {
  if (review.fixed_issues) return review.fixed_issues;
  return (review.linked_issues || []).map((number) => ({
    provider: 'github',
    identifier: `#${number}`,
    url: `https://github.com/${review.repository}/issues/${number}`,
  }));
}

function FixedIssues({ review }: { review: Review }) {
  const issues = fixedIssuesForReview(review);
  if (!issues.length) return null;
  return <p className="fixed-issues"><strong>Fixes </strong>{issues.map((issue, index) => <span key={`${issue.provider}:${issue.identifier}`}>
    {index > 0 && ', '}{issue.url ? <a href={issue.url} target="_blank" rel="noreferrer">{issue.identifier}</a> : issue.identifier}
  </span>)}</p>;
}

function ReviewDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [review, setReview] = useState<Review | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useCloseOnEscape(onClose);
  const load = useCallback(async () => { const detail = await api<{ review: Review; messages: ChatMessage[] }>(`/api/reviews/${encodeURIComponent(id)}`); setReview(detail.review); setMessages(detail.messages); }, [id]);
  useEffect(() => { void load(); }, [load]);
  const action = async (name: string, operation: () => Promise<unknown>) => { setBusy(name); setError(''); try { await operation(); await load(); await onChanged(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(''); } };
  const send = async (event: FormEvent) => { event.preventDefault(); if (busy || !message.trim()) return; const text = message; setMessage(''); await action('chat', () => api(`/api/reviews/${encodeURIComponent(id)}/chat`, { method: 'POST', body: JSON.stringify({ message: text }) })); };
  const submitOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitChat(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="drawer" onMouseDown={(event) => event.stopPropagation()}><button className="drawer-close" onClick={onClose}>×</button>
    {!review ? <p>Loading review…</p> : <><div className="drawer-details"><span className="section-label">{review.repository} · #{review.number} · BY {review.author.startsWith('@') ? review.author : `@${review.author}`}</span><h2>{review.title}</h2><p className="plain-summary">{review.simple_summary}</p><FixedIssues review={review} />
      <div className="drawer-status"><ReviewStatusBadge status={reviewDisplayStatus(review)} />{review.pending_reason && <span>Queued: {review.pending_reason.replaceAll('_', ' ')}</span>}<span>{review.findings_count} blocking issues</span><span>{review.review_skill}</span></div>
      <div className="drawer-actions"><button disabled={!!busy} onClick={() => void action('review', () => api(`/api/reviews/${encodeURIComponent(id)}/run-review`, { method: 'POST', body: '{}' }))}>{busy === 'review' ? 'Starting…' : 'Send review agent'}</button><button disabled={!!busy} onClick={() => void action('workspace', () => api(`/api/reviews/${encodeURIComponent(id)}/workspace`, { method: 'POST', body: '{}' }))}>{busy === 'workspace' ? 'Cloning & building…' : review.workspace_path ? 'Rebuild workspace' : 'Prepare locally'}</button>{review.workspace_path && <button className="muted-button" disabled={!!busy} onClick={() => void action('cleanup', () => api(`/api/reviews/${encodeURIComponent(id)}/workspace`, { method: 'DELETE' }))}>Clean up</button>}<a href={review.url} target="_blank">Open GitHub ↗</a></div>
      {review.workspace_path && <code className="workspace-path">{review.workspace_path}</code>}{error && <p className="inline-error">{error}</p>}</div>
      <section className="review-room"><div className="chat-head"><span className="section-label">REVIEW ROOM</span></div><div className="chat-log">{!messages.length && <p className="chat-empty">Ask what changed, why it matters, what could break, or how to test it.</p>}{messages.map((entry) => <div className={`message ${entry.role}`} key={entry.id}><span>{entry.author}</span><div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.content) }} /></div>)}{busy === 'chat' && <div className="message assistant"><span>agent</span><p className="typing">Thinking…</p></div>}</div>
      <form className="chat-form" onSubmit={(event) => void send(event)}><textarea value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={submitOnEnter} placeholder="Ask about this pull request…" /></form></section>
    </>}
  </aside></div>;
}

function StatusDialog({ dashboard, onClose, onSaved }: { dashboard: Dashboard; onClose: () => void; onSaved: () => Promise<void> }) {
  const initial = useMemo(() => dashboard.statusDraft.lines.join('\n'), [dashboard.statusDraft.lines]);
  const [content, setContent] = useState(initial); const [saved, setSaved] = useState(false);
  useCloseOnEscape(onClose);
  const save = async (copy: boolean) => { await api('/api/status/today', { method: 'PUT', body: JSON.stringify({ content, personalNote: '', copied: copy }) }); if (copy) await navigator.clipboard.writeText(content); setSaved(true); await onSaved(); if (copy) window.setTimeout(onClose, 600); };
  const edit = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const textarea = event.currentTarget;
    const result = editStatusText(content, textarea.selectionStart, textarea.selectionEnd, event.key, event.shiftKey);
    if (!result) return;
    event.preventDefault();
    setContent(result.value);
    window.requestAnimationFrame(() => textarea.setSelectionRange(result.selectionStart, result.selectionEnd));
  };
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="status-modal" onMouseDown={(event) => event.stopPropagation()}><button className="drawer-close" onClick={onClose}>×</button><span className="section-label">STATUS UPDATE · {dashboard.statusDraft.workday}</span><h2>Status update</h2><label>Review and edit today’s update<textarea value={content} onChange={(event) => setContent(event.target.value)} onKeyDown={edit} rows={14} /></label><div className="status-stats"><span>Previous workday</span><b>{dashboard.metrics.previousWorkday.review_completed || 0} reviews</b><b>{dashboard.metrics.previousWorkday.issue_resolved || 0} issues resolved</b><b>{dashboard.metrics.previousWorkday.pr_created || 0} PRs created</b></div><footer><button className="muted-button" onClick={() => void save(false)}>Save changes</button><button onClick={() => void save(true)}>{saved ? 'Copied!' : 'Copy status update'}</button></footer></section></div>;
}
