import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { openAuthoredPullRequests } from './authored-pull-requests.js';
import { authenticatedGithubLogin } from './github-identity.js';

interface StatusReview {
  repository: string;
  number: number;
  title: string;
  updated_at: string;
}

interface StatusWorkItem {
  repository: string;
  number: number;
  title: string;
  priority: number;
  updated_at: string;
}

function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function shortRepository(repository: string): string {
  return repository.split('/').at(-1) || repository;
}

function normalizeStatusText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sortReviews(reviews: StatusReview[], config: BarbarianConfig): StatusReview[] {
  const priorities = new Map(config.repositories.map((repository) => [repository.name.toLowerCase(), repository.priority]));
  return reviews.sort((left, right) =>
    (priorities.get(right.repository.toLowerCase()) || 0) - (priorities.get(left.repository.toLowerCase()) || 0)
    || left.repository.localeCompare(right.repository)
    || right.updated_at.localeCompare(left.updated_at));
}

function previousUnfinishedWork(
  database: BarbarianDatabase,
  previous: string,
  candidates: StatusWorkItem[],
): StatusWorkItem | undefined {
  const saved = database.connection.prepare('SELECT content FROM daily_statuses WHERE workday=?')
    .get(previous) as { content: string } | undefined;
  if (!saved?.content) return undefined;

  for (const line of saved.content.split(/\r?\n/)) {
    const normalizedLine = normalizeStatusText(line);
    if (!normalizedLine) continue;
    const issueNumber = line.match(/(?:issue\s*)?#(\d+)/i)?.[1];
    for (const candidate of candidates) {
      const repository = normalizeStatusText(shortRepository(candidate.repository));
      if (!normalizedLine.startsWith(repository)) continue;
      if (issueNumber && Number(issueNumber) === candidate.number) return candidate;
      const title = normalizeStatusText(candidate.title);
      if (title && normalizedLine.includes(title)) return candidate;
    }
  }
  return undefined;
}

function selectWorkItem(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  previous: string,
): { item: StatusWorkItem; continued: boolean } | undefined {
  const candidates = database.connection.prepare(`
    SELECT repository, number, title, priority, updated_at FROM work_items
    WHERE remote_state='OPEN' AND status IN ('queued','in_progress')
  `).all() as unknown as StatusWorkItem[];
  const continued = previousUnfinishedWork(database, previous, candidates);
  if (continued) return { item: continued, continued: true };

  const highestPriorityRepository = config.repositories
    .filter((repository) => repository.watchIssues)
    .map((repository, index) => ({ repository, index }))
    .sort((left, right) => right.repository.priority - left.repository.priority || left.index - right.index)[0]?.repository;
  if (!highestPriorityRepository) return undefined;

  const item = candidates
    .filter((candidate) => candidate.repository.toLowerCase() === highestPriorityRepository.name.toLowerCase())
    .sort((left, right) =>
      right.priority - left.priority
      || right.updated_at.localeCompare(left.updated_at)
      || right.number - left.number)[0];
  return item ? { item, continued: false } : undefined;
}

export function previousWorkday(now: Date, config: BarbarianConfig): string {
  const candidate = new Date(now);
  const allowed = new Set(config.statusUpdate.workdays.map((day) => day.toLowerCase()));
  for (let attempts = 0; attempts < 14; attempts += 1) {
    candidate.setDate(candidate.getDate() - 1);
    const date = localDate(candidate, config.profile.timezone);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: config.profile.timezone, weekday: 'long' }).format(candidate).toLowerCase();
    if (allowed.has(weekday) && !config.statusUpdate.daysOff.includes(date)) return date;
  }
  return localDate(now, config.profile.timezone);
}

export function buildStatusDraft(database: BarbarianDatabase, config: BarbarianConfig, now = new Date()): {
  workday: string;
  previousWorkday: string;
  lines: string[];
  stats: Record<string, number>;
} {
  const workday = localDate(now, config.profile.timezone);
  const previous = previousWorkday(now, config);
  const login = authenticatedGithubLogin(
    database,
    config.profile.githubLogin || config.review.requestedReviewer,
  ).toLowerCase();
  const needsReview = Number((database.connection.prepare(`
    SELECT COUNT(*) AS total FROM review_queue
    WHERE remote_state='OPEN' AND is_draft=0 AND lower(author)<>?
      AND status<>'approved'
      AND NOT (COALESCE(viewer_review_state, '')='APPROVED' AND viewer_review_sha=head_sha)
  `).get(login) as { total: number }).total);
  const authoredPullRequests = openAuthoredPullRequests(database, login);
  const feedback = sortReviews(
    authoredPullRequests.filter((review) => review.has_new_feedback) as unknown as StatusReview[],
    config,
  );
  const approved = sortReviews(
    authoredPullRequests.filter((review) => review.approved && !review.has_new_feedback) as unknown as StatusReview[],
    config,
  );
  const work = selectWorkItem(database, config, previous);
  const lines = [
    `* Code reviews - ${needsReview} ${needsReview === 1 ? 'PR needs' : 'PRs need'} my review`,
    ...feedback.map((pr) => `* ${shortRepository(pr.repository)} - Address feedback on PR #${pr.number}: ${pr.title}`),
    ...approved.map((pr) => `* ${shortRepository(pr.repository)} - Merge approved PR #${pr.number}: ${pr.title}`),
    ...(work ? [`* ${shortRepository(work.item.repository)} - ${work.continued ? 'Continue' : 'Work on'} issue #${work.item.number}: ${work.item.title}`] : []),
  ];
  const recent = database.connection.prepare(`
    SELECT kind, created_at FROM activity_events ORDER BY created_at DESC LIMIT 2000
  `).all() as Array<{ kind: string; created_at: string }>;
  const stats: Record<string, number> = {};
  for (const event of recent) {
    if (localDate(new Date(event.created_at), config.profile.timezone) !== previous) continue;
    stats[event.kind] = (stats[event.kind] || 0) + 1;
  }
  return {
    workday,
    previousWorkday: previous,
    lines,
    stats,
  };
}
