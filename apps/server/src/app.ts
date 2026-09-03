import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig, ReviewStatus } from './types.js';
import { ConfigConflictError, ConfigStore, projectRoot, type WritableConfig } from './config.js';
import { refreshGithubIssue, synchronize, trackGithubPullRequest } from './sync.js';
import { askAgent, askIssueAgent } from './agents.js';
import { AgentRuntime } from './agent-runtime.js';
import { ReviewDispatcher, reviewTrigger } from './dispatcher.js';
import { cleanupWorkspace, prepareWorkspace } from './workspaces.js';
import { buildStatusDraft } from './status.js';
import { summarizePullRequest } from './summary.js';
import { recordActivity } from './activity.js';
import { buildReviewAssessment, refreshReviewContext, storedReviewFindings } from './review-context.js';
import { completedReviewStatus, displayReviewStatus, newCommitsSinceReview, reviewPriorityScore } from './review-state.js';
import { reviewCardMetadata, type ReviewCardMetadata } from './review-card-metadata.js';
import { fixedIssueReferences } from './fixed-issues.js';
import { configuredAgentEffort, configuredAgentModel } from './agent-display.js';
import { agentSelectionForTask } from './agent-config.js';
import { agentProviderCapabilities, agentProviderFamily } from './agent-provider.js';
import { discoverAgentModels, type AgentModelOption } from './agent-models.js';
import { authoredPullRequestsNeedingAttention } from './authored-pull-requests.js';
import { authenticatedGithubLogin } from './github-identity.js';
import {
  askLocalBranchAgent,
  LocalBranchInputError,
  localBranchFindings,
  runLocalBranchReview,
  upsertLocalBranch,
  type LocalBranchRow,
} from './branch-context.js';

const chatBody = z.object({
  message: z.string().trim().min(1).max(20_000),
  provider: z.string().optional(),
  askAgent: z.boolean().default(true),
  author: z.string().default('Developer'),
  selection: z.object({
    text: z.string().max(16_000),
    path: z.string().max(2_000).optional(),
    line: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    url: z.string().url().max(4_000).optional(),
  }).optional(),
});

const localBranchBody = z.object({
  remote: z.string().trim().min(1).max(2_000),
  branch: z.string().trim().min(1).max(1_000).refine((value) => !value.startsWith('-'), 'Invalid branch name'),
  baseBranch: z.string().trim().min(1).max(1_000),
  baseRef: z.string().trim().min(1).max(1_000).regex(/^[A-Za-z0-9._/~^@{}-]+$/).refine((value) => !value.startsWith('-'), 'Invalid base ref'),
  headSha: z.string().trim().regex(/^[0-9a-f]{7,64}$/i),
  worktreeState: z.string().max(100_000).default(''),
  dirty: z.boolean().default(false),
  workspacePath: z.string().trim().min(1).max(10_000),
  pullRequest: z.object({
    repository: z.string().trim().min(1).max(1_000),
    number: z.number().int().positive(),
    title: z.string().trim().min(1).max(2_000),
    body: z.string().max(100_000).default(''),
    url: z.string().url().max(4_000),
    author: z.string().trim().max(1_000).default(''),
  }).nullable().optional(),
});

const reviewStatuses = new Set<ReviewStatus>([
  'unreviewed', 'agent_working', 'issues_found', 'awaiting_feedback',
  'agent_failed', 'ready_to_merge', 'approved', 'merged', 'closed',
]);

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

interface ActiveLocalBranch {
  repository: string;
  branch_name: string;
}

function branchMatchesIssue(branchName: string, issueNumber: number): boolean {
  const number = String(issueNumber).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[/_-])(?:(?:issue|gh)[_-]?)?${number}(?=$|[/_-])`, 'i').test(branchName);
}

function workItemView(row: Record<string, unknown>, activeBranches: ActiveLocalBranch[]) {
  const payload = parseJson<{ labels?: string[] }>(String(row.payload_json || '{}'));
  const labels = payload.labels || [];
  const fixedOrDuplicate = Boolean(row.fixed_by || row.duplicate_of);
  const localBranch = fixedOrDuplicate ? undefined : activeBranches.find((branch) =>
    branch.repository.toLowerCase() === String(row.repository).toLowerCase()
      && branchMatchesIssue(branch.branch_name, Number(row.number)),
  );
  const labelInProgress = !fixedOrDuplicate && labels.some((label) =>
    /^(?:in[ -]?progress|doing|status[: /-]*in[ -]?progress)$/i.test(label.trim()),
  );
  const inProgressSource = fixedOrDuplicate
    ? null
    : row.in_progress_pr
      ? 'pull_request'
      : localBranch
        ? 'local_branch'
        : labelInProgress
          ? 'label'
          : null;
  return {
    ...row,
    assignees: parseJson<string[]>(String(row.assignees || '[]')),
    priority_reasons: parseJson<string[]>(String(row.priority_reasons)),
    labels,
    in_progress: Boolean(inProgressSource),
    in_progress_source: inProgressSource,
    in_progress_branch: localBranch?.branch_name ?? null,
  };
}

function settingsView(config: BarbarianConfig): {
  config: WritableConfig;
  advanced: {
    workspaceRoot: string;
    linear: { enabled: boolean; configured: boolean };
    providers: Array<{
      name: string;
      supportsModel: boolean;
      supportsEffort: boolean;
      supportsModelDiscovery: boolean;
      models: AgentModelOption[];
      defaultModel: string | null;
    }>;
  };
} {
  return {
    config: {
      profile: config.profile,
      appearance: config.appearance,
      monitor: config.monitor,
      repositories: config.repositories,
      review: {
        requestedReviewer: config.review.requestedReviewer,
        fallbackTeams: config.review.fallbackTeams,
        autoCleanup: config.review.autoCleanup,
      },
      agents: {
        codeReview: config.agents.codeReview,
        chat: config.agents.chat,
        autoReview: config.agents.autoReview,
        maxConcurrent: config.agents.maxConcurrent,
        maxAutomaticAttempts: config.agents.maxAutomaticAttempts,
        retryBaseMinutes: config.agents.retryBaseMinutes,
        maxRunsPerPullRequestPerHour: config.agents.maxRunsPerPullRequestPerHour,
      },
      statusUpdate: config.statusUpdate,
    },
    advanced: {
      workspaceRoot: config.review.workspaceRoot,
      linear: { enabled: config.linear.enabled, configured: config.linear.command.length > 0 },
      providers: Object.entries(config.agents.providers).map(([name, provider]) => {
        const capabilities = agentProviderCapabilities(provider.command);
        return {
          name,
          supportsModel: capabilities.model,
          supportsEffort: capabilities.effort,
          supportsModelDiscovery: ['codex', 'claude', 'cursor'].includes(agentProviderFamily(provider.command)),
          models: [],
          defaultModel: null,
        };
      }),
    },
  };
}

const emptyCardMetadata: ReviewCardMetadata = {
  last_agent_review_at: null,
  issue_counts: { high: 0, medium: 0, low: 0 },
};

function rowToReview(
  row: Record<string, unknown>,
  config: BarbarianConfig,
  cardMetadata: ReviewCardMetadata = emptyCardMetadata,
) {
  const reviewPaused = Boolean(row.review_paused);
  const linkedIssues = parseJson<number[]>(String(row.linked_issues));
  const review = {
    ...row,
    pending_reason: reviewPaused ? null : reviewTrigger({
      manual_requested_at: row.manual_requested_at ? String(row.manual_requested_at) : null,
      head_sha: String(row.head_sha),
      last_reviewed_sha: row.last_reviewed_sha ? String(row.last_reviewed_sha) : null,
      discussion_watermark: String(row.discussion_watermark || ''),
      last_reviewed_watermark: row.last_reviewed_watermark === null ? null : String(row.last_reviewed_watermark || ''),
    }),
    review_paused: reviewPaused,
    is_draft: Boolean(row.is_draft),
    requested_reviewers: parseJson<string[]>(String(row.requested_reviewers)),
    requested_teams: parseJson<string[]>(String(row.requested_teams)),
    linked_issues: linkedIssues,
    fixed_issues: fixedIssueReferences(String(row.repository), String(row.body || ''), linkedIssues),
  };
  const repositoryPriority = config.repositories.find(
    (repository) => repository.name.toLowerCase() === String(row.repository).toLowerCase(),
  )?.priority ?? 0;
  const reviewState = {
    status: String(row.status),
    head_sha: String(row.head_sha),
    viewer_review_state: row.viewer_review_state ? String(row.viewer_review_state) : null,
    viewer_review_sha: row.viewer_review_sha ? String(row.viewer_review_sha) : null,
    other_approvals: Number(row.other_approvals || 0),
  };
  return {
    ...review,
    display_status: displayReviewStatus(reviewState),
    repository_priority: repositoryPriority,
    priority_score: reviewPriorityScore(reviewState, repositoryPriority),
    remote_created_at: row.remote_created_at ? String(row.remote_created_at) : String(row.first_seen_at),
    remote_updated_at: row.remote_updated_at ? String(row.remote_updated_at) : String(row.updated_at),
    new_commit_count: newCommitsSinceReview({
      head_sha: String(row.head_sha),
      last_reviewed_sha: row.last_reviewed_sha ? String(row.last_reviewed_sha) : null,
      commit_count: Number(row.commit_count || 0),
      last_reviewed_commit_count: row.last_reviewed_commit_count === null
        ? null
        : Number(row.last_reviewed_commit_count || 0),
    }),
    ...cardMetadata,
  };
}

function reviewContextPayload(database: BarbarianDatabase, config: BarbarianConfig, row: Record<string, unknown>) {
  const metadata = reviewCardMetadata(database).get(String(row.id));
  const review = rowToReview(row, config, metadata);
  const findings = storedReviewFindings(database, String(row.id)).map((finding) => ({
    ...finding,
    resolved: Boolean(finding.resolved),
    outdated: Boolean(finding.outdated),
  }));
  return {
    review,
    findings,
    assessment: buildReviewAssessment(review as unknown as Parameters<typeof buildReviewAssessment>[0], findings),
  };
}

function markAuthoredFeedbackSeen(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  row: Record<string, unknown>,
): void {
  const login = authenticatedGithubLogin(
    database,
    config.profile.githubLogin || config.review.requestedReviewer,
  ).toLowerCase();
  if (!login || String(row.author).toLowerCase() !== login) return;
  database.connection.prepare(`
    UPDATE review_queue SET author_seen_watermark=discussion_watermark
    WHERE id=? AND discussion_watermark>COALESCE(author_seen_watermark, '')
  `).run(String(row.id));
}

function agentRunView(config: BarbarianConfig, row: Record<string, unknown>) {
  const agent = String(row.provider);
  const repository = row.review_repository || row.issue_repository || row.branch_repository || null;
  const title = row.review_title || row.issue_title || row.branch_name || String(row.task).replaceAll('_', ' ');
  return {
    id: Number(row.id),
    review_id: row.review_id ? String(row.review_id) : null,
    branch_id: row.branch_id ? String(row.branch_id) : null,
    agent,
    model: configuredAgentModel(config, agent, String(row.task)),
    effort: configuredAgentEffort(config, agent, String(row.task)),
    task: String(row.task),
    status: String(row.status),
    started_at: String(row.started_at),
    finished_at: row.finished_at ? String(row.finished_at) : null,
    repository: repository ? String(repository) : null,
    number: row.review_number === null || row.review_number === undefined
      ? row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number)
      : Number(row.review_number),
    title: String(title),
    url: row.review_url || row.issue_url ? String(row.review_url || row.issue_url) : null,
    branch_name: row.branch_name ? String(row.branch_name) : null,
  };
}

const agentRunColumns = `
  agent_runs.id, agent_runs.review_id, agent_runs.branch_id, agent_runs.work_item_id,
  agent_runs.provider, agent_runs.task, agent_runs.status, agent_runs.started_at, agent_runs.finished_at,
  review_queue.repository AS review_repository,
  review_queue.number AS review_number,
  review_queue.title AS review_title,
  review_queue.url AS review_url,
  work_items.repository AS issue_repository,
  work_items.number AS issue_number,
  work_items.title AS issue_title,
  work_items.url AS issue_url,
  local_branches.repository AS branch_repository,
  local_branches.branch_name AS branch_name
`;

const agentRunJoins = `
  FROM agent_runs
  LEFT JOIN review_queue ON review_queue.id=agent_runs.review_id
  LEFT JOIN work_items ON work_items.id=agent_runs.work_item_id
  LEFT JOIN local_branches ON local_branches.id=agent_runs.branch_id
`;

const agentRunSelect = `
  SELECT ${agentRunColumns}
  ${agentRunJoins}
`;

const agentRunDetailSelect = `
  SELECT agent_runs.command, agent_runs.prompt, agent_runs.error, ${agentRunColumns}
  ${agentRunJoins}
`;

function dashboardApiAllowed(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return /^(127\.0\.0\.1|localhost)$/.test(parsed.hostname) && parsed.host === host;
  } catch {
    return false;
  }
}

function localAgentApiAllowed(origin: string | undefined, host: string | undefined): boolean {
  return dashboardApiAllowed(origin, host);
}

function refreshStoredReviewSummaries(database: BarbarianDatabase): void {
  const key = 'review_summary_version';
  const version = '2';
  const current = database.connection.prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(key) as { value: string } | undefined;
  if (current?.value === version) return;
  const rows = database.connection.prepare(`
    SELECT id, title, body FROM review_queue WHERE trim(body)<>''
  `).all() as Array<{ id: string; title: string; body: string }>;
  const update = database.connection.prepare('UPDATE review_queue SET simple_summary=? WHERE id=?');
  database.connection.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) update.run(summarizePullRequest(row.title, row.body), row.id);
    database.connection.prepare(`
      INSERT INTO app_metadata(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(key, version);
    database.connection.exec('COMMIT');
  } catch (error) {
    database.connection.exec('ROLLBACK');
    throw error;
  }
}

function todayParts(config: BarbarianConfig): { date: string; weekday: string } {
  const now = new Date();
  return {
    date: new Intl.DateTimeFormat('en-CA', {
      timeZone: config.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now),
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: config.profile.timezone, weekday: 'long' }).format(now).toLowerCase(),
  };
}

export interface MonitorRuntime {
  nextSyncAt: string | null;
}

export async function createApp(
  database: BarbarianDatabase,
  configStore: ConfigStore,
  monitorRuntime: MonitorRuntime = { nextSyncAt: null },
  services: {
    runtime?: AgentRuntime;
    dispatcher?: ReviewDispatcher;
    onConfigUpdated?: (previous: BarbarianConfig, next: BarbarianConfig) => void | Promise<void>;
    onManualSyncStarted?: () => void;
    onManualSyncFinished?: () => void;
    refreshReview?: typeof refreshReviewContext;
    refreshIssue?: typeof refreshGithubIssue;
    trackReview?: typeof trackGithubPullRequest;
  } = {},
) {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  try { refreshStoredReviewSummaries(database); }
  catch (error) { app.log.warn(error, 'could not refresh stored pull request summaries'); }
  const initialConfig = configStore.get();
  const runtime = services.runtime || new AgentRuntime(initialConfig.agents.maxConcurrent);
  const dispatcher = services.dispatcher || new ReviewDispatcher(database, () => configStore.get(), runtime, app.log);
  const refreshReview = services.refreshReview || refreshReviewContext;
  const refreshIssue = services.refreshIssue || refreshGithubIssue;
  const trackReview = services.trackReview || trackGithubPullRequest;
  const dashboardClients = new Set<ServerResponse>();
  const publishReviewUpdated = (id: string) => {
    const message = `event: review-updated\ndata: ${JSON.stringify({ id })}\n\n`;
    for (const client of dashboardClients) client.write(message);
  };
  const publishDashboardUpdated = (id: string) => {
    const message = `event: dashboard-updated\ndata: ${JSON.stringify({ id })}\n\n`;
    for (const client of dashboardClients) client.write(message);
  };
  dispatcher.setReviewChangedListener(publishReviewUpdated);
  await app.register(cors, {
    origin(origin, callback) {
      const allowed = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
        || origin.startsWith('chrome-extension://') || origin.startsWith('vscode-webview://');
      callback(allowed ? null : new Error('Origin not allowed'), allowed);
    },
  });

  app.get('/api/health', async () => ({ ok: true, now: new Date().toISOString() }));

  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(': connected\n\n');
    dashboardClients.add(reply.raw);
    request.raw.on('close', () => dashboardClients.delete(reply.raw));
  });

  app.addHook('onClose', async () => {
    for (const client of dashboardClients) client.end();
    dashboardClients.clear();
  });

  app.get('/api/dashboard', async () => {
    const config = configStore.get();
    const cardMetadata = reviewCardMetadata(database);
    const activeBranchCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const activeBranches = database.connection.prepare(`
      SELECT repository, branch_name FROM local_branches WHERE last_seen_at >= ?
    `).all(activeBranchCutoff) as unknown as ActiveLocalBranch[];
    const workQueue = database.connection.prepare(`
      SELECT * FROM work_items WHERE remote_state='OPEN'
      ORDER BY priority DESC, updated_at DESC
    `).all().map((row) => workItemView(row as Record<string, unknown>, activeBranches));
    const login = (config.profile.githubLogin || config.review.requestedReviewer).trim().toLowerCase();
    const openReviewRows = database.connection.prepare(`
      SELECT * FROM review_queue WHERE remote_state='OPEN'
      ORDER BY updated_at DESC
    `).all() as Array<Record<string, unknown>>;
    const reviews = openReviewRows.filter((record) =>
      !login || String(record.author).toLowerCase() !== login,
    ).map((record) => {
      return rowToReview(record, config, cardMetadata.get(String(record.id)));
    });
    const feedback = authoredPullRequestsNeedingAttention(database, login).map((record) => {
      const review = rowToReview(record, config, cardMetadata.get(String(record.id)));
      return {
        ...review,
        approved: record.approved,
        has_new_feedback: record.has_new_feedback,
      };
    });
    const lastSync = database.connection.prepare(`
      SELECT * FROM sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1
    `).get();
    const activeAgents = (database.connection.prepare(`
      ${agentRunSelect}
      WHERE agent_runs.status='running'
      ORDER BY agent_runs.started_at ASC
    `).all() as Array<Record<string, unknown>>).map((row) => agentRunView(config, row));
    const agentWorking = activeAgents.length;
    const waiting = Number((database.connection.prepare(`
      SELECT COUNT(*) AS total FROM review_queue
      WHERE status IN ('issues_found','awaiting_feedback') AND remote_state='OPEN'
    `).get() as { total: number }).total);
    const queuedIssues = workQueue.length;
    const reviewsNeedingApproval = reviews.filter((review) => review.display_status !== 'approved').length;
    const needsAttention = queuedIssues + reviewsNeedingApproval;
    const draft = buildStatusDraft(database, config);
    const savedStatus = database.connection.prepare('SELECT * FROM daily_statuses WHERE workday=?').get(draft.workday);
    const day = todayParts(config);
    const statusDue = config.statusUpdate.enabled
      && config.statusUpdate.workdays.includes(day.weekday)
      && !config.statusUpdate.daysOff.includes(day.date)
      && !savedStatus;
    return {
      profile: config.profile,
      appearance: config.appearance,
      monitor: { ...config.monitor, nextSyncAt: monitorRuntime.nextSyncAt },
      repositories: config.repositories.map((repository) => ({
        name: repository.name,
        url: `https://github.com/${repository.name.split('/').map(encodeURIComponent).join('/')}`,
      })),
      activeAgents,
      workQueue,
      feedback,
      reviews,
      metrics: { needsAttention, queuedIssues, reviewsNeedingApproval, agentWorking, waiting, previousWorkday: draft.stats },
      statusDraft: draft,
      statusDue,
      lastSync,
    };
  });

  app.get('/api/agent-runs/:id/status', async (request, reply) => {
    if (!dashboardApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Dashboard access required' });
    const id = z.coerce.number().int().positive().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: 'Invalid agent run id' });
    const row = database.connection.prepare(`
      SELECT status, finished_at, error FROM agent_runs WHERE id=?
    `).get(id.data) as { status: string; finished_at: string | null; error: string | null } | undefined;
    if (!row) return reply.code(404).send({ error: 'Agent run not found' });
    return row;
  });

  app.get('/api/agent-runs/:id', async (request, reply) => {
    if (!dashboardApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Dashboard access required' });
    const id = z.coerce.number().int().positive().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: 'Invalid agent run id' });
    const row = database.connection.prepare(`${agentRunDetailSelect} WHERE agent_runs.id=?`)
      .get(id.data) as Record<string, unknown> | undefined;
    if (!row) return reply.code(404).send({ error: 'Agent run not found' });
    return {
      ...agentRunView(configStore.get(), row),
      command: String(row.command || ''),
      prompt: String(row.prompt || ''),
      error: row.error ? String(row.error) : null,
    };
  });

  app.delete('/api/agent-runs/:id', async (request, reply) => {
    if (!dashboardApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Dashboard access required' });
    const id = z.coerce.number().int().positive().safeParse((request.params as { id: string }).id);
    if (!id.success) return reply.code(400).send({ error: 'Invalid agent run id' });
    const run = database.connection.prepare(`
      SELECT id, review_id, branch_id, task, status, runtime_key FROM agent_runs WHERE id=?
    `).get(id.data) as {
      id: number; review_id: string | null; branch_id: string | null;
      task: string; status: string; runtime_key: string | null;
    } | undefined;
    if (!run) return reply.code(404).send({ error: 'Agent run not found' });
    if (run.status !== 'running') return reply.code(409).send({ error: 'Agent is no longer running' });

    let cancelled = 0;
    if (!run.runtime_key) return reply.code(409).send({ error: 'This agent run cannot be stopped' });
    cancelled = runtime.cancel(run.runtime_key, new Error('Stopped by user'));
    if (!cancelled) return reply.code(409).send({ error: 'Agent is no longer running' });

    if (run.task === 'local_branch_review' && run.branch_id) {
      database.connection.prepare(`
        UPDATE local_branches SET status='unreviewed', last_agent_error=NULL, updated_at=? WHERE id=?
      `).run(new Date().toISOString(), run.branch_id);
    }

    const now = new Date().toISOString();
    database.connection.prepare(`
      UPDATE agent_runs SET status='cancelled', finished_at=?, error='Stopped by user', prompt=''
      WHERE id=? AND status='running'
    `).run(now, run.id);
    publishDashboardUpdated(String(run.id));
    return { ok: true, stopped: true, cancelled };
  });

  app.post('/api/sync', async (_request, reply) => {
    services.onManualSyncStarted?.();
    try {
      const config = configStore.get();
      const result = await synchronize(database, config);
      await dispatcher.pump();
      return reply.send(result);
    } finally {
      services.onManualSyncFinished?.();
    }
  });

  app.get('/api/work-items', async () => database.connection.prepare(`
    SELECT * FROM work_items ORDER BY remote_state='OPEN' DESC, priority DESC, updated_at DESC
  `).all());

  app.patch('/api/work-items/:id', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = z.object({ status: z.enum(['queued', 'in_progress', 'waiting', 'done', 'dismissed']) }).parse(request.body);
    const result = database.connection.prepare('UPDATE work_items SET status=?, updated_at=? WHERE id=?')
      .run(body.status, new Date().toISOString(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Work item not found' });
    recordActivity(database, body.status === 'done' ? 'issue_resolved' : 'work_status_changed', `${id} → ${body.status}`, id);
    return { ok: true };
  });

  app.get('/api/reviews', async () => {
    const config = configStore.get();
    const cardMetadata = reviewCardMetadata(database);
    return database.connection.prepare(`
      SELECT * FROM review_queue ORDER BY remote_state='OPEN' DESC, updated_at DESC
    `).all().map((row) => {
      const record = row as Record<string, unknown>;
      return rowToReview(record, config, cardMetadata.get(String(record.id)));
    });
  });

  app.get('/api/reviews/:id', async (request, reply) => {
    const config = configStore.get();
    const id = decodeURIComponent((request.params as { id: string }).id);
    const review = database.connection.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    const messages = database.connection.prepare(`
      SELECT * FROM chat_messages WHERE review_id=? ORDER BY id ASC
    `).all(id);
    const runs = database.connection.prepare(`
      SELECT id, provider, task, status, started_at, finished_at, error
      FROM agent_runs WHERE review_id=? ORDER BY id DESC LIMIT 20
    `).all(id);
    const record = review as Record<string, unknown>;
    const payload = { ...reviewContextPayload(database, config, record), messages, runs };
    markAuthoredFeedbackSeen(database, config, record);
    return payload;
  });

  app.patch('/api/reviews/:id', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = z.object({ status: z.string() }).parse(request.body);
    if (!reviewStatuses.has(body.status as ReviewStatus)) return reply.code(400).send({ error: 'Invalid review status' });
    const result = database.connection.prepare('UPDATE review_queue SET status=?, updated_at=? WHERE id=?')
      .run(body.status, new Date().toISOString(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Review not found' });
    return { ok: true };
  });

  app.post('/api/reviews/:id/chat', async (request, reply) => {
    const config = configStore.get();
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = chatBody.parse(request.body);
    const review = database.connection.prepare('SELECT id FROM review_queue WHERE id=?').get(id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO chat_messages(review_id, role, author, content, created_at) VALUES (?, 'user', ?, ?, ?)
    `).run(id, body.author, body.message, now);
    if (!body.askAgent) return { message: null };
    const runtimeKey = `agent-run:${randomUUID()}`;
    const response = await runtime.run(
      (signal) => askAgent(database, config, id, body.message, body.provider, signal, {
        runtimeKey,
        ...(body.selection ? { untrustedSelection: body.selection } : {}),
      }),
      runtimeKey,
    );
    const inserted = database.connection.prepare(`
      INSERT INTO chat_messages(review_id, role, author, content, created_at) VALUES (?, 'assistant', ?, ?, ?)
    `).run(id, body.provider || agentSelectionForTask(config, 'chat').provider, response, new Date().toISOString());
    return { message: { id: Number(inserted.lastInsertRowid), role: 'assistant', author: body.provider || agentSelectionForTask(config, 'chat').provider, content: response } };
  });

  app.post('/api/reviews/:id/track', async (request, reply) => {
    const config = configStore.get();
    const id = decodeURIComponent((request.params as { id: string }).id);
    const match = id.match(/^github:([^/]+\/[^#]+)#(\d+)$/);
    if (!match) return reply.code(400).send({ error: 'Invalid GitHub pull request id' });
    const trackedId = await trackReview(database, config, match[1]!, Number(match[2]));
    if (trackedId !== id) return reply.code(409).send({ error: 'GitHub returned a different pull request' });
    if (!dispatcher.requestManual(id)) return reply.code(500).send({ error: 'Pull request was added, but its review could not be started' });
    publishReviewUpdated(id);
    publishDashboardUpdated(id);
    return reply.code(202).send({ accepted: true, id });
  });

  app.post('/api/reviews/:id/run-review', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = z.object({ provider: z.string().optional() }).parse(request.body || {});
    const review = database.connection.prepare('SELECT id FROM review_queue WHERE id=?').get(id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    if (!dispatcher.requestManual(id, body.provider)) return reply.code(404).send({ error: 'Review not found' });
    return reply.code(202).send({ accepted: true });
  });

  app.delete('/api/reviews/:id/run-review', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const result = dispatcher.cancelReview(id);
    if (!result.found) return reply.code(404).send({ error: 'Review not found' });
    if (result.stopped) {
      recordActivity(database, 'agent_review_cancelled', `Stopped agent work for ${id}`, id, { cancelled: result.cancelled });
    }
    return { ok: true, stopped: result.stopped, cancelled: result.cancelled };
  });

  app.post('/api/reviews/:id/workspace', async (request, reply) => {
    const config = configStore.get();
    const id = decodeURIComponent((request.params as { id: string }).id);
    const workspace = await prepareWorkspace(database, config, id);
    return reply.send({ workspace });
  });

  app.delete('/api/reviews/:id/workspace', async (request, reply) => {
    const config = configStore.get();
    const id = decodeURIComponent((request.params as { id: string }).id);
    await cleanupWorkspace(database, config, id);
    return reply.send({ ok: true });
  });

  app.get('/api/status/today', async () => {
    const config = configStore.get();
    const draft = buildStatusDraft(database, config);
    const saved = database.connection.prepare('SELECT * FROM daily_statuses WHERE workday=?').get(draft.workday);
    return { draft, saved };
  });

  app.put('/api/status/today', async (request) => {
    const config = configStore.get();
    const body = z.object({ content: z.string().max(20_000), personalNote: z.string().max(5_000).default(''), copied: z.boolean().default(false) }).parse(request.body);
    const draft = buildStatusDraft(database, config);
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO daily_statuses(workday, content, personal_note, created_at, updated_at, copied_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workday) DO UPDATE SET content=excluded.content, personal_note=excluded.personal_note,
        updated_at=excluded.updated_at, copied_at=COALESCE(excluded.copied_at, daily_statuses.copied_at)
    `).run(draft.workday, body.content, body.personalNote, now, now, body.copied ? now : null);
    return { ok: true };
  });

  app.get('/api/browser/context', async (request, reply) => {
    const config = configStore.get();
    const query = z.object({
      url: z.string().url(),
      refresh: z.enum(['1', 'true']).optional(),
    }).parse(request.query);
    const match = new URL(query.url).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return reply.code(400).send({ error: 'Not a GitHub pull request URL' });
    const id = `github:${match[1]}/${match[2]}#${match[3]}`;
    let review = database.connection.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
    if (!review) return { id, appearance: config.appearance, review: null, findings: [], assessment: null, messages: [] };
    if (query.refresh) {
      await refreshReview(database, id);
      review = database.connection.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
      if (!review) return reply.code(404).send({ error: 'Review is no longer tracked' });
      publishReviewUpdated(id);
    }
    const messages = database.connection.prepare(`
      SELECT * FROM (
        SELECT id, role, author, substr(content, 1, 4000) AS content, created_at
        FROM chat_messages WHERE review_id=? ORDER BY id DESC LIMIT 12
      ) ORDER BY id ASC
    `).all(id);
    const record = review as Record<string, unknown>;
    return {
      id,
      appearance: config.appearance,
      ...reviewContextPayload(database, config, record),
      messages,
    };
  });

  app.get('/api/browser/issue-context', async (request, reply) => {
    const config = configStore.get();
    const query = z.object({
      url: z.string().url(),
      refresh: z.enum(['1', 'true']).optional(),
    }).parse(request.query);
    const parsed = new URL(query.url);
    const match = parsed.hostname === 'github.com'
      ? parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/)
      : null;
    if (!match) return reply.code(400).send({ error: 'Not a GitHub issue URL' });
    const repository = `${match[1]}/${match[2]}`;
    const number = Number(match[3]);
    const id = `github:${repository}#${number}`;
    const configured = config.repositories.some((candidate) =>
      candidate.name.toLowerCase() === repository.toLowerCase() && candidate.watchIssues,
    );
    if (!configured) {
      return { kind: 'issue', id, appearance: config.appearance, configured: false, tracked: false, issue: null, messages: [] };
    }
    let issue = database.connection.prepare("SELECT * FROM work_items WHERE id=? AND kind='issue'").get(id);
    if (query.refresh || !issue) {
      await refreshIssue(database, config, repository, number);
      issue = database.connection.prepare("SELECT * FROM work_items WHERE id=? AND kind='issue'").get(id);
      publishDashboardUpdated(id);
    }
    if (!issue) return reply.code(404).send({ error: 'Issue was not found' });
    const messages = database.connection.prepare(`
      SELECT * FROM (
        SELECT id, role, author, substr(content, 1, 4000) AS content, created_at
        FROM issue_chat_messages WHERE work_item_id=? ORDER BY id DESC LIMIT 20
      ) ORDER BY id ASC
    `).all(id);
    const record = issue as Record<string, unknown>;
    return {
      kind: 'issue', id, appearance: config.appearance, configured: true,
      tracked: record.remote_state === 'OPEN',
      issue: workItemView(record, []),
      messages,
    };
  });

  app.post('/api/issues/:id/chat', async (request, reply) => {
    const config = configStore.get();
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = chatBody.parse(request.body);
    const issue = database.connection.prepare("SELECT id FROM work_items WHERE id=? AND kind='issue'").get(id);
    if (!issue) return reply.code(404).send({ error: 'Issue not found' });
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO issue_chat_messages(work_item_id, role, author, content, created_at)
      VALUES (?, 'user', ?, ?, ?)
    `).run(id, body.author, body.message, now);
    if (!body.askAgent) return { message: null };
    const runtimeKey = `agent-run:${randomUUID()}`;
    const response = await runtime.run(
      (signal) => askIssueAgent(
        database, config, id, body.message, body.provider, signal, runtimeKey, body.selection,
      ),
      runtimeKey,
    );
    const inserted = database.connection.prepare(`
      INSERT INTO issue_chat_messages(work_item_id, role, author, content, created_at)
      VALUES (?, 'assistant', ?, ?, ?)
    `).run(id, body.provider || agentSelectionForTask(config, 'issue_chat').provider, response, new Date().toISOString());
    return {
      message: {
        id: Number(inserted.lastInsertRowid), role: 'assistant',
        author: body.provider || agentSelectionForTask(config, 'issue_chat').provider, content: response,
      },
    };
  });

  app.get('/api/local/context', async (request) => {
    const config = configStore.get();
    const query = z.object({ remote: z.string(), branch: z.string().optional() }).parse(request.query);
    const match = query.remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (!match) return { reviews: [] };
    const repository = `${match[1]}/${match[2]}`;
    const rows = database.connection.prepare(`
      SELECT * FROM review_queue WHERE repository=? AND remote_state='OPEN'
        AND (? IS NULL OR head_ref_name=?) ORDER BY updated_at DESC
    `).all(repository, query.branch || null, query.branch || null);
    const cardMetadata = reviewCardMetadata(database);
    return { reviews: rows.map((row) => {
      const record = row as Record<string, unknown>;
      return rowToReview(record, config, cardMetadata.get(String(record.id)));
    }) };
  });

  app.post('/api/local/branches/context', async (request, reply) => {
    if (!localAgentApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Editor access required' });
    const config = configStore.get();
    try {
      const branch = await upsertLocalBranch(database, localBranchBody.parse(request.body));
      let linkedReview: Record<string, unknown> | undefined;
      if (branch.review_id) {
        const review = database.connection.prepare('SELECT * FROM review_queue WHERE id=?').get(branch.review_id);
        if (review) linkedReview = review as Record<string, unknown>;
        const hasCurrentLocalReview = branch.last_reviewed_sha === branch.head_sha
          && branch.last_reviewed_worktree_state === branch.worktree_state;
        if (review && !branch.is_dirty && branch.status !== 'agent_working' && !hasCurrentLocalReview) {
          const messages = database.connection.prepare(`
            SELECT * FROM (
              SELECT id, role, author, substr(content, 1, 4000) AS content, created_at
              FROM chat_messages WHERE review_id=? ORDER BY id DESC LIMIT 20
            ) ORDER BY id ASC
          `).all(branch.review_id);
          return {
            appearance: config.appearance,
            branch,
            ...reviewContextPayload(database, config, linkedReview!),
            messages,
          };
        }
      }
      const findings = localBranchFindings(database, branch.id);
      const messages = linkedReview ? database.connection.prepare(`
          SELECT * FROM (
            SELECT id, role, author, substr(content, 1, 4000) AS content, created_at
            FROM chat_messages WHERE review_id=? ORDER BY id DESC LIMIT 20
          ) ORDER BY id ASC
        `).all(branch.review_id) : database.connection.prepare(`
          SELECT * FROM (
            SELECT id, role, author, substr(content, 1, 4000) AS content, created_at
            FROM local_branch_messages WHERE branch_id=? ORDER BY id DESC LIMIT 20
          ) ORDER BY id ASC
        `).all(branch.id);
      const stale = Boolean(
        branch.last_reviewed_sha && branch.last_reviewed_sha !== branch.head_sha
        || branch.last_reviewed_worktree_state !== null
          && branch.last_reviewed_worktree_state !== branch.worktree_state,
      );
      let message = 'Run an agent review to check this branch before it becomes a pull request.';
      if (branch.status === 'agent_working') message = 'An AI reviewer is checking this branch now.';
      else if (branch.status === 'agent_failed') message = branch.last_agent_error || 'The AI reviewer failed.';
      else if (branch.last_agent_error) message = branch.last_agent_error;
      else if (stale) message = 'The branch changed after the last AI review. It needs another pass.';
      else if (findings.length) message = `${findings.length} agent ${findings.length === 1 ? 'finding needs' : 'findings need'} attention.`;
      else if (branch.last_reviewed_sha) message = 'The latest agent review found no issues.';
      if (branch.is_dirty && linkedReview) {
        message = `This working tree has local changes, so Agent review checks the branch locally. ${message}`;
      }
      if (branch.base_branch === 'previous commit') {
        message = `Base branch could not be discovered; this review compares against the previous commit. ${message}`;
      }
      return {
        appearance: config.appearance,
        branch,
        review: linkedReview ? rowToReview(linkedReview, config, reviewCardMetadata(database).get(String(linkedReview.id))) : null,
        pullRequest: !linkedReview && branch.pull_request_number ? {
          repository: branch.pull_request_repository,
          number: branch.pull_request_number,
          title: branch.pull_request_title,
          summary: branch.pull_request_summary,
          url: branch.pull_request_url,
          author: branch.pull_request_author,
        } : null,
        findings,
        messages,
        assessment: {
          message,
          stale,
          counts: { open: findings.length, resolved: 0, outdated: 0, total: findings.length },
        },
      };
    } catch (error) {
      if (error instanceof ZodError || error instanceof LocalBranchInputError) {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/local/branches/:id/run-review', async (request, reply) => {
    if (!localAgentApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Editor access required' });
    const id = decodeURIComponent((request.params as { id: string }).id);
    const branch = database.connection.prepare('SELECT * FROM local_branches WHERE id=?').get(id) as unknown as LocalBranchRow | undefined;
    if (!branch) return reply.code(404).send({ error: 'Local branch is not tracked' });
    const body = z.object({ provider: z.string().optional() }).parse(request.body || {});
    if (branch.status === 'agent_working') return reply.code(409).send({ error: 'An agent review is already running' });
    if (branch.review_id && !branch.is_dirty && dispatcher.requestManual(branch.review_id, body.provider)) {
      return reply.code(202).send({ accepted: true, target: 'pull_request' });
    }
    database.connection.prepare(`
      UPDATE local_branches SET status='agent_working', last_agent_error=NULL, updated_at=? WHERE id=?
    `).run(new Date().toISOString(), id);
    void runtime.run(
      (signal) => runLocalBranchReview(database, configStore.get(), id, signal),
      id,
    ).catch((error) => {
      database.connection.prepare(`
        UPDATE local_branches SET status='unreviewed', last_agent_error=?, updated_at=?
        WHERE id=? AND status='agent_working'
      `).run(
        error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000),
        new Date().toISOString(), id,
      );
      app.log.error(error, `local branch review failed for ${id}`);
    });
    return reply.code(202).send({ accepted: true, target: 'branch' });
  });

  app.delete('/api/local/branches/:id/run-review', async (request, reply) => {
    if (!localAgentApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Editor access required' });
    const id = decodeURIComponent((request.params as { id: string }).id);
    const branch = database.connection.prepare('SELECT * FROM local_branches WHERE id=?').get(id) as unknown as LocalBranchRow | undefined;
    if (!branch) return reply.code(404).send({ error: 'Local branch is not tracked' });
    const localCancelled = runtime.cancel(id, new Error('Agent review stopped by user'));
    const pullRequest = branch.review_id ? dispatcher.cancelReview(branch.review_id) : null;
    database.connection.prepare(`
      UPDATE local_branches SET status='unreviewed', last_agent_error=NULL, updated_at=? WHERE id=?
    `).run(new Date().toISOString(), id);
    return {
      ok: true,
      stopped: localCancelled > 0 || Boolean(pullRequest?.stopped),
      cancelled: localCancelled + (pullRequest?.cancelled || 0),
    };
  });

  app.post('/api/local/branches/:id/chat', async (request, reply) => {
    if (!localAgentApiAllowed(request.headers.origin, request.headers.host)) return reply.code(403).send({ error: 'Editor access required' });
    const id = decodeURIComponent((request.params as { id: string }).id);
    const branch = database.connection.prepare('SELECT * FROM local_branches WHERE id=?').get(id) as unknown as LocalBranchRow | undefined;
    if (!branch) return reply.code(404).send({ error: 'Local branch is not tracked' });
    const config = configStore.get();
    const body = chatBody.parse(request.body);
    const now = new Date().toISOString();
    if (branch.review_id) {
      const review = database.connection.prepare('SELECT id FROM review_queue WHERE id=?').get(branch.review_id);
      if (!review) return reply.code(404).send({ error: 'The linked pull request is no longer tracked' });
      database.connection.prepare(`
        INSERT INTO chat_messages(review_id, role, author, content, created_at) VALUES (?, 'user', ?, ?, ?)
      `).run(branch.review_id, body.author, body.message, now);
      if (!body.askAgent) return { message: null };
      const runtimeKey = `agent-run:${randomUUID()}`;
      const response = await runtime.run(
        (signal) => askAgent(database, config, branch.review_id!, body.message, body.provider, signal, {
          branchId: id,
          cwd: branch.workspace_path,
          workspaceWrite: true,
          runtimeKey,
          ...(body.selection ? { untrustedSelection: body.selection } : {}),
        }),
        runtimeKey,
      );
      const inserted = database.connection.prepare(`
        INSERT INTO chat_messages(review_id, role, author, content, created_at) VALUES (?, 'assistant', ?, ?, ?)
      `).run(branch.review_id, body.provider || agentSelectionForTask(config, 'chat').provider, response, new Date().toISOString());
      return { message: { id: Number(inserted.lastInsertRowid), role: 'assistant', author: body.provider || agentSelectionForTask(config, 'chat').provider, content: response } };
    }
    database.connection.prepare(`
      INSERT INTO local_branch_messages(branch_id, role, author, content, created_at) VALUES (?, 'user', ?, ?, ?)
    `).run(id, body.author, body.message, now);
    if (!body.askAgent) return { message: null };
    const runtimeKey = `agent-run:${randomUUID()}`;
    const response = await runtime.run(
      (signal) => askLocalBranchAgent(
        database, config, id, body.message, body.provider, signal, runtimeKey, body.selection,
      ),
      runtimeKey,
    );
    const inserted = database.connection.prepare(`
      INSERT INTO local_branch_messages(branch_id, role, author, content, created_at) VALUES (?, 'assistant', ?, ?, ?)
    `).run(id, body.provider || agentSelectionForTask(config, 'local_branch_chat').provider, response, new Date().toISOString());
    return { message: { id: Number(inserted.lastInsertRowid), role: 'assistant', author: body.provider || agentSelectionForTask(config, 'local_branch_chat').provider, content: response } };
  });

  app.get('/api/settings', async () => ({
    ...settingsView(configStore.get()), revision: configStore.revision,
    warning: configStore.warning, configFile: 'config/barbarian.yaml',
  }));

  app.get('/api/settings/agent-models', async () => ({
    providers: await Promise.all(Object.entries(configStore.get().agents.providers).map(async ([name, provider]) => ({
      name,
      ...await discoverAgentModels(provider),
    }))),
  }));

  app.put('/api/settings', async (request, reply) => {
    try {
      const origin = request.headers.origin;
      if (origin?.startsWith('chrome-extension://') || origin?.startsWith('vscode-webview://')) {
        return reply.code(403).send({ error: 'Settings may only be changed from the Barbarian dashboard.' });
      }
      const body = z.object({ revision: z.string().min(1), config: z.unknown() }).parse(request.body);
      const previous = configStore.get();
      const updated = await configStore.update(body.config, body.revision);
      runtime.setMaxConcurrent(updated.config.agents.maxConcurrent);
      await services.onConfigUpdated?.(previous, updated.config);
      void dispatcher.pump();
      return { ok: true, ...settingsView(updated.config), revision: updated.revision };
    } catch (error) {
      if (error instanceof ConfigConflictError) return reply.code(409).send({ error: error.message });
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: 'Configuration is invalid',
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      app.log.error(error, 'could not persist settings');
      return reply.code(500).send({ error: error instanceof Error ? error.message : 'Could not save settings' });
    }
  });

  app.post('/api/integrations/review-result', async (request, reply) => {
    const body = z.object({
      repository: z.string(), number: z.number().int().positive(), headSha: z.string(),
      discussionWatermark: z.string(),
      findings: z.number().int().min(0), summary: z.string().default(''),
    }).parse(request.body);
    const id = `github:${body.repository}#${body.number}`;
    const review = database.connection.prepare(
      'SELECT approval_carryover FROM review_queue WHERE id=?',
    ).get(id) as { approval_carryover: number } | undefined;
    const status = completedReviewStatus(body.findings, Boolean(review?.approval_carryover));
    const result = database.connection.prepare(`
      UPDATE review_queue SET status=CASE
          WHEN head_sha<>? OR discussion_watermark>? THEN 'unreviewed' ELSE ? END,
        findings_count=?, last_reviewed_sha=?, last_reviewed_commit_count=commit_count,
        last_reviewed_watermark=?,
        plain_summary=CASE WHEN ?='' THEN plain_summary ELSE ? END, updated_at=? WHERE id=?
    `).run(
      body.headSha, body.discussionWatermark, status, body.findings, body.headSha,
      body.discussionWatermark, body.summary.trim(), body.summary.trim(), new Date().toISOString(), id,
    );
    if (!result.changes) return reply.code(404).send({ error: 'Review is not tracked by Barbarian' });
    recordActivity(database, 'agent_review_completed', `${body.repository}#${body.number}: ${body.findings} issues`, id, body);
    void refreshReviewContext(database, id).catch((error) => app.log.warn(error, 'could not refresh review comments'));
    return { ok: true, status };
  });

  const webRoot = path.join(projectRoot, 'dist/web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
