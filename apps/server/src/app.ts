import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig, ReviewStatus } from './types.js';
import { projectRoot } from './config.js';
import { synchronize } from './sync.js';
import { askAgent, runReviewAgent } from './agents.js';
import { cleanupWorkspace, prepareWorkspace } from './workspaces.js';
import { buildStatusDraft } from './status.js';
import { recordActivity } from './activity.js';

const chatBody = z.object({
  message: z.string().trim().min(1).max(20_000),
  provider: z.string().optional(),
  askAgent: z.boolean().default(true),
  author: z.string().default('Developer'),
});

const reviewStatuses = new Set<ReviewStatus>([
  'unreviewed', 'agent_working', 'issues_found', 'awaiting_feedback',
  'ready_to_merge', 'approved', 'merged', 'closed',
]);

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function rowToReview(row: Record<string, unknown>) {
  return {
    ...row,
    is_draft: Boolean(row.is_draft),
    requested_reviewers: parseJson<string[]>(String(row.requested_reviewers)),
    requested_teams: parseJson<string[]>(String(row.requested_teams)),
    linked_issues: parseJson<number[]>(String(row.linked_issues)),
  };
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

export async function createApp(database: BarbarianDatabase, config: BarbarianConfig) {
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, {
    origin(origin, callback) {
      const allowed = !origin || /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
        || origin.startsWith('chrome-extension://') || origin.startsWith('vscode-webview://');
      callback(allowed ? null : new Error('Origin not allowed'), allowed);
    },
  });

  app.get('/api/health', async () => ({ ok: true, now: new Date().toISOString() }));

  app.get('/api/dashboard', async () => {
    const workQueue = database.connection.prepare(`
      SELECT * FROM work_items WHERE remote_state='OPEN'
      ORDER BY CASE status WHEN 'queued' THEN 0 ELSE 1 END, priority DESC, updated_at DESC LIMIT 12
    `).all().map((row) => ({
      ...row,
      priority_reasons: parseJson<string[]>(String((row as Record<string, unknown>).priority_reasons)),
    }));
    const reviews = database.connection.prepare(`
      SELECT * FROM review_queue WHERE remote_state='OPEN'
      ORDER BY CASE status
        WHEN 'issues_found' THEN 0 WHEN 'unreviewed' THEN 1 WHEN 'agent_working' THEN 2
        WHEN 'awaiting_feedback' THEN 3 WHEN 'ready_to_merge' THEN 4 WHEN 'approved' THEN 5 ELSE 6 END,
        updated_at DESC LIMIT 12
    `).all().map((row) => rowToReview(row as Record<string, unknown>));
    const lastSync = database.connection.prepare(`
      SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1
    `).get();
    const agentWorking = Number((database.connection.prepare(
      "SELECT COUNT(*) AS total FROM review_queue WHERE status='agent_working' AND remote_state='OPEN'",
    ).get() as { total: number }).total);
    const waiting = Number((database.connection.prepare(`
      SELECT COUNT(*) AS total FROM review_queue
      WHERE status IN ('issues_found','awaiting_feedback') AND remote_state='OPEN'
    `).get() as { total: number }).total);
    const needsAttention = Number((database.connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM work_items WHERE status='queued' AND remote_state='OPEN') +
        (SELECT COUNT(*) FROM review_queue WHERE status='unreviewed' AND remote_state='OPEN') AS total
    `).get() as { total: number }).total);
    const draft = buildStatusDraft(database, config);
    const savedStatus = database.connection.prepare('SELECT * FROM daily_statuses WHERE workday=?').get(draft.workday);
    const day = todayParts(config);
    const statusDue = config.statusUpdate.enabled
      && config.statusUpdate.workdays.includes(day.weekday)
      && !config.statusUpdate.daysOff.includes(day.date)
      && !savedStatus;
    return {
      profile: config.profile,
      monitor: config.monitor,
      workQueue,
      reviews,
      metrics: { needsAttention, agentWorking, waiting, previousWorkday: draft.stats },
      statusDraft: draft,
      statusDue,
      lastSync,
    };
  });

  app.post('/api/sync', async (_request, reply) => {
    const result = await synchronize(database, config);
    return reply.send(result);
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

  app.get('/api/reviews', async () => database.connection.prepare(`
    SELECT * FROM review_queue ORDER BY remote_state='OPEN' DESC, updated_at DESC
  `).all().map((row) => rowToReview(row as Record<string, unknown>)));

  app.get('/api/reviews/:id', async (request, reply) => {
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
    return { review: rowToReview(review as Record<string, unknown>), messages, runs };
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
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = chatBody.parse(request.body);
    const review = database.connection.prepare('SELECT id FROM review_queue WHERE id=?').get(id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO chat_messages(review_id, role, author, content, created_at) VALUES (?, 'user', ?, ?, ?)
    `).run(id, body.author, body.message, now);
    if (!body.askAgent) return { message: null };
    const response = await askAgent(database, config, id, body.message, body.provider);
    const inserted = database.connection.prepare(`
      INSERT INTO chat_messages(review_id, role, author, content, created_at) VALUES (?, 'assistant', ?, ?, ?)
    `).run(id, body.provider || config.agents.default, response, new Date().toISOString());
    return { message: { id: Number(inserted.lastInsertRowid), role: 'assistant', author: body.provider || config.agents.default, content: response } };
  });

  app.post('/api/reviews/:id/run-review', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const body = z.object({ provider: z.string().optional() }).parse(request.body || {});
    const review = database.connection.prepare('SELECT id FROM review_queue WHERE id=?').get(id);
    if (!review) return reply.code(404).send({ error: 'Review not found' });
    void runReviewAgent(database, config, id, body.provider).catch((error) => app.log.error(error));
    return reply.code(202).send({ accepted: true });
  });

  app.post('/api/reviews/:id/workspace', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const workspace = await prepareWorkspace(database, config, id);
    return reply.send({ workspace });
  });

  app.delete('/api/reviews/:id/workspace', async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    await cleanupWorkspace(database, config, id);
    return reply.send({ ok: true });
  });

  app.get('/api/status/today', async () => {
    const draft = buildStatusDraft(database, config);
    const saved = database.connection.prepare('SELECT * FROM daily_statuses WHERE workday=?').get(draft.workday);
    return { draft, saved };
  });

  app.put('/api/status/today', async (request) => {
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
    const query = z.object({ url: z.string().url() }).parse(request.query);
    const match = new URL(query.url).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return reply.code(400).send({ error: 'Not a GitHub pull request URL' });
    const id = `github:${match[1]}/${match[2]}#${match[3]}`;
    const review = database.connection.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
    return { id, review: review ? rowToReview(review as Record<string, unknown>) : null };
  });

  app.get('/api/local/context', async (request) => {
    const query = z.object({ remote: z.string(), branch: z.string().optional() }).parse(request.query);
    const match = query.remote.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
    if (!match) return { reviews: [] };
    const repository = `${match[1]}/${match[2]}`;
    const rows = database.connection.prepare(`
      SELECT * FROM review_queue WHERE repository=? AND remote_state='OPEN'
        AND (? IS NULL OR head_ref_name=?) ORDER BY updated_at DESC
    `).all(repository, query.branch || null, query.branch || null);
    return { reviews: rows.map((row) => rowToReview(row as Record<string, unknown>)) };
  });

  app.get('/api/settings', async () => ({
    profile: config.profile,
    monitor: config.monitor,
    repositories: config.repositories,
    agents: { default: config.agents.default, providers: Object.keys(config.agents.providers) },
    configFile: 'config/barbarian.yaml',
    envFile: '.env',
  }));

  app.post('/api/integrations/review-result', async (request, reply) => {
    const body = z.object({
      repository: z.string(), number: z.number().int().positive(), headSha: z.string(),
      findings: z.number().int().min(0), summary: z.string().default(''),
    }).parse(request.body);
    const id = `github:${body.repository}#${body.number}`;
    const status = body.findings > 0 ? 'issues_found' : 'ready_to_merge';
    const result = database.connection.prepare(`
      UPDATE review_queue SET status=?, findings_count=?, last_reviewed_sha=?, updated_at=? WHERE id=?
    `).run(status, body.findings, body.headSha, new Date().toISOString(), id);
    if (!result.changes) return reply.code(404).send({ error: 'Review is not tracked by Barbarian' });
    recordActivity(database, 'agent_review_completed', `${body.repository}#${body.number}: ${body.findings} issues`, id, body);
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
