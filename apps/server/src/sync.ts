import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig, DiscoveryResult, DiscoveredIssue, DiscoveredPullRequest } from './types.js';
import { discoverGithub, discoverGithubActivity, fetchPullRequestState } from './github.js';
import { recordActivity } from './activity.js';
import { explainPullRequest, simplify, summarizePullRequest } from './summary.js';
import { discoverLinear } from './linear.js';
import { refreshReviewContext } from './review-context.js';
import { viewerApprovedCurrentHead, viewerRequestedChangesCurrentHead } from './review-state.js';

function issueId(issue: DiscoveredIssue): string {
  return `${issue.provider}:${issue.repository}#${issue.number}`;
}

function reviewId(pr: DiscoveredPullRequest): string {
  return `github:${pr.repository}#${pr.number}`;
}

function hasInProgressLabel(labels: string[]): boolean {
  return labels.some((label) => /^(?:in[ -]?progress|doing|status[: /-]*in[ -]?progress)$/i.test(label.trim()));
}

function upsertIssue(database: BarbarianDatabase, issue: DiscoveredIssue, seenAt: string): void {
  const id = issueId(issue);
  const existed = database.connection.prepare('SELECT 1 FROM work_items WHERE id = ?').get(id);
  database.connection.prepare(`
    INSERT INTO work_items(
      id, provider, repository, number, kind, title, body, simple_summary, url, assignees,
      priority, priority_reasons, status, milestone, duplicate_of, in_progress_pr,
      fixed_by, remote_state, payload_json, first_seen_at, updated_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, body=excluded.body, simple_summary=excluded.simple_summary,
      url=excluded.url, assignees=excluded.assignees,
      priority=excluded.priority, priority_reasons=excluded.priority_reasons,
      milestone=excluded.milestone, duplicate_of=excluded.duplicate_of,
      in_progress_pr=excluded.in_progress_pr, fixed_by=excluded.fixed_by,
      remote_state='OPEN', payload_json=excluded.payload_json,
      updated_at=excluded.updated_at, last_seen_at=excluded.last_seen_at
  `).run(
    id, issue.provider, issue.repository, issue.number, issue.title, issue.body,
    simplify(issue.title, issue.body), issue.url, JSON.stringify(issue.assignees), issue.priority, JSON.stringify(issue.priorityReasons),
    issue.fixedBy ? 'already_fixed' : issue.duplicateOf ? 'duplicate'
      : issue.inProgressPr || hasInProgressLabel(issue.labels) ? 'in_progress' : 'queued',
    issue.milestone, issue.duplicateOf, issue.inProgressPr, issue.fixedBy, JSON.stringify(issue),
    seenAt, issue.updatedAt, seenAt,
  );
  if (!existed) recordActivity(database, 'issue_discovered', `${issue.repository}#${issue.number} added to the work queue`, id);
}

function configuredSkill(config: BarbarianConfig, repository: string): string {
  return config.repositories.find((entry) => entry.name === repository)?.reviewSkill || 'cb1-code-review';
}

function shouldTrackReview(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  pr: DiscoveredPullRequest,
  githubLogin: string,
): boolean {
  const target = config.review.requestedReviewer || githubLogin;
  const explicitlyRequested = pr.requestedReviewers.some((login) => login.toLowerCase() === target.toLowerCase());
  const alreadyReviewed = pr.reviewedBy.some((login) => login.toLowerCase() === target.toLowerCase());
  const fallbackTeam = pr.requestedReviewers.length === 0 && pr.requestedTeams.some((team) =>
    config.review.fallbackTeams.some((candidate) => candidate.toLowerCase() === team.toLowerCase()),
  );
  const tracked = database.connection.prepare('SELECT 1 FROM review_queue WHERE id = ?').get(reviewId(pr));
  return Boolean(explicitlyRequested || alreadyReviewed || fallbackTeam || tracked);
}

function upsertReview(database: BarbarianDatabase, config: BarbarianConfig, pr: DiscoveredPullRequest, seenAt: string): void {
  const id = reviewId(pr);
  const existing = database.connection.prepare(
    `SELECT head_sha, last_reviewed_sha, discussion_watermark, last_reviewed_watermark,
      attempt_head_sha, attempt_watermark, status FROM review_queue WHERE id = ?`,
  ).get(id) as {
    head_sha: string;
    last_reviewed_sha: string | null;
    discussion_watermark: string;
    last_reviewed_watermark: string | null;
    attempt_head_sha: string | null;
    attempt_watermark: string | null;
    status: string;
  } | undefined;

  const watermark = pr.discussionWatermark > (existing?.discussion_watermark || '')
    ? pr.discussionWatermark
    : existing?.discussion_watermark || '';
  const failedOnCurrentInput = existing?.status === 'agent_failed'
    && existing.attempt_head_sha === pr.headSha
    && existing.attempt_watermark === watermark;
  let status = existing?.status || 'unreviewed';
  const viewerReview = {
    head_sha: pr.headSha,
    viewer_review_state: pr.viewerReviewState,
    viewer_review_sha: pr.viewerReviewSha,
  };
  if (viewerApprovedCurrentHead(viewerReview)) status = 'approved';
  else if (viewerRequestedChangesCurrentHead(viewerReview)) status = 'awaiting_feedback';
  else if (status === 'approved') status = 'unreviewed';
  else if (status !== 'agent_working' && !failedOnCurrentInput && (
    !existing?.last_reviewed_sha
    || existing.last_reviewed_sha !== pr.headSha
    || (existing.last_reviewed_watermark !== null && watermark > existing.last_reviewed_watermark)
  )) status = 'unreviewed';

  database.connection.prepare(`
    INSERT INTO review_queue(
      id, repository, number, title, simple_summary, plain_summary, body, url, author, additions, deletions, head_sha,
      head_ref_name, base_ref_name, status, review_decision, requested_reviewers,
      requested_teams, linked_issues, review_skill, discussion_watermark, is_draft, remote_state,
      remote_updated_at, first_seen_at, updated_at, last_seen_at, merged_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, simple_summary=excluded.simple_summary,
      plain_summary=CASE WHEN review_queue.plain_summary='' THEN excluded.plain_summary ELSE review_queue.plain_summary END,
      body=excluded.body,
      url=excluded.url, author=excluded.author, additions=excluded.additions,
      deletions=excluded.deletions, head_sha=excluded.head_sha,
      head_ref_name=excluded.head_ref_name, base_ref_name=excluded.base_ref_name,
      status=excluded.status, review_decision=excluded.review_decision,
      requested_reviewers=excluded.requested_reviewers, requested_teams=excluded.requested_teams,
      linked_issues=excluded.linked_issues, review_skill=excluded.review_skill,
      discussion_watermark=excluded.discussion_watermark,
      review_paused=CASE
        WHEN review_queue.head_sha<>excluded.head_sha
          OR excluded.discussion_watermark>review_queue.discussion_watermark THEN 0
        ELSE review_queue.review_paused END,
      is_draft=excluded.is_draft, remote_state='OPEN', updated_at=excluded.updated_at,
      remote_updated_at=excluded.remote_updated_at, last_seen_at=excluded.last_seen_at,
      merged_at=excluded.merged_at
  `).run(
    id, pr.repository, pr.number, pr.title, summarizePullRequest(pr.title, pr.body), explainPullRequest(pr.title, pr.body), pr.body,
    pr.url, pr.author, pr.additions, pr.deletions, pr.headSha, pr.headRefName, pr.baseRefName, status,
    pr.reviewDecision, JSON.stringify(pr.requestedReviewers), JSON.stringify(pr.requestedTeams),
    JSON.stringify(pr.linkedIssues), configuredSkill(config, pr.repository), watermark, pr.isDraft ? 1 : 0,
    pr.updatedAt, seenAt, pr.updatedAt, seenAt, pr.mergedAt,
  );
  database.connection.prepare(`
    UPDATE review_queue SET viewer_review_state=?, viewer_review_sha=?, other_approvals=?,
      remote_created_at=? WHERE id=?
  `).run(
    pr.viewerReviewState, pr.viewerReviewSha, pr.otherApprovals, pr.createdAt, id,
  );
  database.connection.prepare(`
    UPDATE local_branches SET review_id=?, updated_at=?
    WHERE repository=? AND branch_name=?
  `).run(id, seenAt, pr.repository, pr.headRefName);
  if (!existing) recordActivity(database, 'review_discovered', `${pr.repository}#${pr.number} added to the review queue`, id);
  else if (existing.head_sha !== pr.headSha) recordActivity(database, 'review_updated', `${pr.repository}#${pr.number} has new commits`, id);
}

async function closeMissingReviews(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  seenIds: Set<string>,
): Promise<void> {
  const watched = new Set(config.repositories.filter((repo) => repo.watchPullRequests).map((repo) => repo.name));
  const rows = database.connection.prepare(`
    SELECT id, repository, number, status, workspace_path FROM review_queue WHERE remote_state = 'OPEN'
  `).all() as Array<{ id: string; repository: string; number: number; status: string; workspace_path: string | null }>;
  for (const row of rows) {
    if (seenIds.has(row.id) || !watched.has(row.repository)) continue;
    try {
      const remote = await fetchPullRequestState(row.repository, row.number);
      if (remote.state === 'OPEN') continue;
      const status = remote.mergedAt ? 'merged' : 'closed';
      database.connection.prepare(`
        UPDATE review_queue SET remote_state = ?, status = ?, merged_at = ?, updated_at = ? WHERE id = ?
      `).run(remote.state, status, remote.mergedAt, new Date().toISOString(), row.id);
      recordActivity(database, status === 'merged' ? 'pr_merged' : 'pr_closed', `${row.repository}#${row.number} ${status}`, row.id);
    } catch {
      // A transient lifecycle lookup is retried on the next durable sweep.
    }
  }
}

export async function applyDiscovery(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  discovery: DiscoveryResult,
): Promise<void> {
  for (const issue of discovery.issues) upsertIssue(database, issue, discovery.discoveredAt);

  const successfulRepos = config.repositories
    .filter((repo) => !discovery.warnings.some((warning) => warning.startsWith(`${repo.name}:`)));
  for (const repo of successfulRepos) {
    database.connection.prepare(`
      UPDATE work_items SET remote_state = 'MISSING', status = 'unavailable'
      WHERE provider = 'github' AND repository = ? AND kind = 'issue' AND last_seen_at <> ?
    `).run(repo.name, discovery.discoveredAt);
  }
  if (config.linear.enabled && !discovery.warnings.some((warning) => warning.startsWith('linear:'))) {
    database.connection.prepare(`
      UPDATE work_items SET remote_state='MISSING', status='unavailable'
      WHERE provider='linear' AND kind='issue' AND last_seen_at <> ?
    `).run(discovery.discoveredAt);
  }

  const seenReviewIds = new Set<string>();
  for (const pr of discovery.pullRequests) {
    seenReviewIds.add(reviewId(pr));
    if (pr.isDraft && !config.monitor.includeDraftPullRequests) continue;
    if (shouldTrackReview(database, config, pr, discovery.githubLogin)) {
      upsertReview(database, config, pr, discovery.discoveredAt);
    }
  }
  await closeMissingReviews(database, config, seenReviewIds);
}

let activeSync: Promise<DiscoveryResult> | null = null;

export function synchronize(database: BarbarianDatabase, config: BarbarianConfig): Promise<DiscoveryResult> {
  if (activeSync) return activeSync;
  activeSync = (async () => {
    const startedAt = new Date().toISOString();
    const insert = database.connection.prepare(
      "INSERT INTO sync_runs(started_at, status) VALUES (?, 'running')",
    ).run(startedAt);
    const syncId = Number(insert.lastInsertRowid);
    try {
      const discovery = await discoverGithub(config);
      if (config.linear.enabled) {
        try { discovery.issues.push(...await discoverLinear(config)); }
        catch (error) { discovery.warnings.push(`linear: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await applyDiscovery(database, config, discovery);
      const trackedReviews = database.connection.prepare(`
        SELECT id FROM review_queue WHERE remote_state='OPEN' ORDER BY updated_at DESC
      `).all() as Array<{ id: string }>;
      for (const review of trackedReviews) {
        try { await refreshReviewContext(database, review.id); }
        catch (error) {
          discovery.warnings.push(`review context ${review.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        const from = new Date();
        from.setDate(from.getDate() - 14);
        const watched = new Set(config.repositories.map((repository) => repository.name));
        const activities = await discoverGithubActivity(discovery.githubLogin, from, watched);
        for (const activity of activities) {
          database.connection.prepare(`
            INSERT OR IGNORE INTO activity_events(kind, subject_id, remote_key, summary, payload_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(
            activity.kind, `github:${activity.repository}#${activity.number}`, activity.remoteKey,
            `${activity.repository}#${activity.number}: ${activity.title}`, JSON.stringify(activity), activity.occurredAt,
          );
        }
      } catch (error) {
        discovery.warnings.push(`activity: ${error instanceof Error ? error.message : String(error)}`);
      }
      database.connection.prepare(`
        UPDATE sync_runs SET finished_at=?, status='complete', issues_seen=?, prs_seen=?, warnings=? WHERE id=?
      `).run(new Date().toISOString(), discovery.issues.length, discovery.pullRequests.length, JSON.stringify(discovery.warnings), syncId);
      return discovery;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      database.connection.prepare(`
        UPDATE sync_runs SET finished_at=?, status='failed', error=? WHERE id=?
      `).run(new Date().toISOString(), message, syncId);
      throw error;
    } finally {
      activeSync = null;
    }
  })();
  return activeSync;
}
