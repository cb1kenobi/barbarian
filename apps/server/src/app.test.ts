import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { BarbarianConfig } from './types.js';
import { BarbarianDatabase } from './database.js';
import { ConfigStore } from './config.js';
import type { ReviewDispatcher } from './dispatcher.js';
import { AgentRuntime } from './agent-runtime.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
  version: 1,
  profile: { name: 'Chris', reviewName: '', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  appearance: { theme: 'dark', fontSize: 'small', weapon: 'double-axe' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [{ name: 'Acme/storage', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    codeReview: { provider: 'codex', model: '', effort: '' },
    chat: { provider: 'codex', model: '', effort: '' },
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: {},
  },
  statusUpdate: { enabled: false, workdays: [], daysOff: [] },
};

describe('agent runs', () => {
  it('stops the running agent represented by the side-panel record', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-agent-run-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const runtime = new AgentRuntime(1);
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const execution = runtime.run((signal) => new Promise<void>((_resolve, reject) => {
      announceStarted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'github:Acme/storage#issue-42');
    const outcome = execution.catch((error: unknown) => error);
    await started;
    const inserted = database.connection.prepare(`
      INSERT INTO agent_runs(provider, task, status, started_at, runtime_key)
      VALUES ('codex', 'issue_chat', 'running', ?, 'github:Acme/storage#issue-42')
    `).run(new Date().toISOString());
    const app = await createApp(database, new ConfigStore(config), undefined, { runtime });
    try {
      const status = await app.inject({
        method: 'GET', url: `/api/agent-runs/${Number(inserted.lastInsertRowid)}/status`,
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toEqual({ status: 'running', finished_at: null, error: null });
      const response = await app.inject({
        method: 'DELETE', url: `/api/agent-runs/${Number(inserted.lastInsertRowid)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, stopped: true, cancelled: 1 });
      expect(await outcome).toMatchObject({ message: 'Stopped by user' });
      expect(database.connection.prepare('SELECT status, error FROM agent_runs WHERE id=?')
        .get(Number(inserted.lastInsertRowid))).toEqual({ status: 'cancelled', error: 'Stopped by user' });
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('dashboard reviews', () => {
  it('returns every open issue and review with explicit attention counts', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-app-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const insert = database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        first_seen_at, updated_at, last_seen_at
      ) VALUES (?, 'Acme/storage', ?, ?, ?, 'author', ?, 'feature', 'main', ?, ?, ?)
    `);
    for (let number = 1; number <= 500; number += 1) {
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString();
      insert.run(
        `github:Acme/storage#${number}`, number, `Review ${number}`, `https://example.test/${number}`,
        `head-${number}`, timestamp, timestamp, timestamp,
      );
    }
    const insertWork = database.connection.prepare(`
      INSERT INTO work_items(
        id, provider, repository, number, kind, title, url, priority_reasons,
        first_seen_at, updated_at, last_seen_at
      ) VALUES (?, 'github', 'Acme/storage', ?, 'issue', ?, ?, '[]', ?, ?, ?)
    `);
    for (let number = 1; number <= 15; number += 1) {
      const timestamp = new Date(Date.UTC(2026, 0, 2, 0, 0, number)).toISOString();
      insertWork.run(
        `github:Acme/storage#issue-${number}`, number, `Issue ${number}`,
        `https://example.test/issues/${number}`, timestamp, timestamp, timestamp,
      );
    }
    database.connection.prepare(`
      UPDATE work_items SET assignees='["cb1kenobi"]', in_progress_pr='https://github.com/Acme/storage/pull/99'
      WHERE number=1
    `).run();
    const branchSeenAt = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO local_branches(
        id,repository,remote_url,branch_name,base_branch,base_ref,head_sha,workspace_path,
        first_seen_at,updated_at,last_seen_at
      ) VALUES ('branch:issue-2','Acme/storage','git@github.com:Acme/storage.git','feature/issue-2-fix',
        'main','origin/main','abcdef1','/tmp/storage',?,?,?)
    `).run(branchSeenAt, branchSeenAt, branchSeenAt);
    database.connection.prepare(`
      UPDATE review_queue SET remote_updated_at='2026-01-02T03:04:00Z',
        linked_issues='[12,34]', body='Fixes ENG-9', commit_count=7,
        last_reviewed_sha='old-head', last_reviewed_commit_count=4 WHERE number=1
    `).run();
    database.connection.prepare(`
      INSERT INTO agent_runs(review_id,provider,task,status,started_at,finished_at)
      VALUES ('github:Acme/storage#1','codex','code_review:new_pr','complete',
        '2026-01-02T04:00:00Z','2026-01-02T04:05:00Z')
    `).run();
    database.connection.prepare(`
      INSERT INTO agent_runs(review_id,provider,task,status,started_at)
      VALUES ('github:Acme/storage#2','codex','code_review:new_pr','running','2026-01-02T05:00:00Z')
    `).run();
    const issueChatRun = database.connection.prepare(`
      INSERT INTO agent_runs(work_item_id,provider,task,status,started_at,command,prompt)
      VALUES ('github:Acme/storage#issue-1','codex','issue_chat','running',
        '2026-01-02T05:15:00Z','codex exec -','Explain issue #1')
    `).run();
    database.connection.prepare(`
      UPDATE review_queue SET status='agent_working', claim_owner='claim-3',
        claimed_at='2026-01-02T05:30:00Z' WHERE number=3
    `).run();
    database.connection.prepare(`
      UPDATE review_queue SET status='agent_working', claim_owner='claim-4',
        claimed_at='2026-01-02T06:00:00Z' WHERE number=4
    `).run();
    database.connection.prepare(`
      INSERT INTO agent_runs(review_id,provider,task,status,started_at,finished_at)
      VALUES ('github:Acme/storage#4','codex','code_review:new_pr','complete',
        '2026-01-02T06:00:01Z','2026-01-02T06:05:00Z')
    `).run();
    const finding = database.connection.prepare(`
      INSERT INTO review_findings(
        id,review_id,remote_id,author,body,summary,url,resolved,outdated,created_at,updated_at
      ) VALUES (?, 'github:Acme/storage#1', ?, 'agent', ?, '', 'https://example.test/finding', 0, 0,
        '2026-01-02T04:05:00Z','2026-01-02T04:05:00Z')
    `);
    finding.run('finding-high', 1, '**High: blocking bug**');
    finding.run('finding-low', 2, 'Nit: simplify this');

    const app = await createApp(database, new ConfigStore(config));
    try {
      const response = await app.inject({ method: 'GET', url: '/api/dashboard' });
      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        reviews: Array<Record<string, unknown>>;
        workQueue: Array<Record<string, unknown>>;
        repositories: Array<{ name: string; url: string }>;
        activeAgents: Array<Record<string, unknown>>;
        metrics: { needsAttention: number; queuedIssues: number; reviewsNeedingApproval: number; agentWorking: number };
        statusDraft: { lines: string[] };
      };
      const reviews = payload.reviews;
      expect(reviews).toHaveLength(500);
      expect(payload.workQueue).toHaveLength(15);
      expect(payload.workQueue.find((item) => item.number === 1)).toMatchObject({
        assignees: ['cb1kenobi'], in_progress: true, in_progress_source: 'pull_request',
      });
      expect(payload.workQueue.find((item) => item.number === 2)).toMatchObject({
        assignees: [], in_progress: true, in_progress_source: 'local_branch',
        in_progress_branch: 'feature/issue-2-fix',
      });
      expect(payload.repositories).toEqual([{
        name: 'Acme/storage', url: 'https://github.com/Acme/storage',
      }]);
      expect(payload.activeAgents).toEqual([expect.objectContaining({
        repository: 'Acme/storage', number: 2, agent: 'codex', model: 'CLI default',
        task: 'code_review:new_pr', started_at: '2026-01-02T05:00:00Z',
      }), expect.objectContaining({
        repository: 'Acme/storage', number: 1, title: 'Issue 1', agent: 'codex', model: 'CLI default',
        task: 'issue_chat', started_at: '2026-01-02T05:15:00Z',
      })]);
      expect(payload.metrics).toMatchObject({
        needsAttention: 515,
        queuedIssues: 15,
        reviewsNeedingApproval: 500,
        agentWorking: 2,
      });
      const runResponse = await app.inject({
        method: 'GET', url: `/api/agent-runs/${Number(issueChatRun.lastInsertRowid)}`,
      });
      expect(runResponse.statusCode).toBe(200);
      expect(runResponse.json()).toMatchObject({
        repository: 'Acme/storage', number: 1, title: 'Issue 1',
        task: 'issue_chat', status: 'running', command: 'codex exec -', prompt: 'Explain issue #1',
      });
      const extensionRunResponse = await app.inject({
        method: 'GET', url: `/api/agent-runs/${Number(issueChatRun.lastInsertRowid)}`,
        headers: { origin: 'chrome-extension://unrelated-extension' },
      });
      expect(extensionRunResponse.statusCode).toBe(403);
      const otherLocalAppResponse = await app.inject({
        method: 'GET', url: `/api/agent-runs/${Number(issueChatRun.lastInsertRowid)}`,
        headers: { origin: 'http://localhost:3000' },
      });
      expect(otherLocalAppResponse.statusCode).toBe(403);
      expect(reviews.find((review) => review.number === 1)).toMatchObject({
        remote_updated_at: '2026-01-02T03:04:00Z',
        last_agent_review_at: '2026-01-02T04:05:00Z',
        new_commit_count: 3,
        issue_counts: { high: 1, medium: 0, low: 1 },
        fixed_issues: [
          { provider: 'github', identifier: '#12', url: 'https://github.com/Acme/storage/issues/12' },
          { provider: 'github', identifier: '#34', url: 'https://github.com/Acme/storage/issues/34' },
          { provider: 'linear', identifier: 'ENG-9', url: null },
        ],
      });
      expect(payload.statusDraft.lines).toEqual([
        '* Code reviews - 500 PRs need my review',
        '* storage - Work on issue #15: Issue 15',
      ]);
    } finally {
      await app.close();
      database.close();
    }
  });

  it('separates authored PRs with feedback or approval from the review queue', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-feedback-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const insert = database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, simple_summary, url, author, head_sha,
        head_ref_name, base_ref_name, status, review_decision, discussion_watermark,
        last_reviewed_watermark, is_draft, first_seen_at, updated_at, last_seen_at
      ) VALUES (?, 'Acme/storage', ?, ?, ?, ?, ?, ?, 'feature', 'main', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const addReview = (number: number, author: string, status: string, decision: string | null,
      discussion: string, reviewed: string | null, draft = false) => {
      const timestamp = `2026-01-02T0${number}:00:00Z`;
      insert.run(
        `github:Acme/storage#${number}`, number, `Review ${number}`, `Summary ${number}`,
        `https://github.com/Acme/storage/pull/${number}`, author, `head-${number}`,
        status, decision, discussion, reviewed, draft ? 1 : 0, timestamp, timestamp, timestamp,
      );
    };
    addReview(1, 'another-author', 'unreviewed', null, '', null);
    addReview(2, 'cb1kenobi', 'unreviewed', 'APPROVED', '', null);
    addReview(3, 'CB1Kenobi', 'unreviewed', null, '2026-01-02T03:00:00Z', '2026-01-01T03:00:00Z');
    addReview(4, 'cb1kenobi', 'unreviewed', 'APPROVED', '', null, true);
    addReview(5, 'cb1kenobi', 'unreviewed', null, '', null);
    addReview(6, 'cb1kenobi', 'unreviewed', 'APPROVED', '2026-01-02T06:00:00Z', '2026-01-01T06:00:00Z');
    addReview(7, 'cb1kenobi', 'unreviewed', null, '2026-01-02T07:00:00Z', null);

    const app = await createApp(database, new ConfigStore(config));
    try {
      const response = await app.inject({ method: 'GET', url: '/api/dashboard' });
      expect(response.statusCode).toBe(200);
      const payload = response.json() as {
        reviews: Array<{ number: number }>;
        feedback: Array<{ number: number; approved: boolean; has_new_feedback: boolean }>;
        metrics: { reviewsNeedingApproval: number };
      };
      expect(payload.reviews).toEqual([expect.objectContaining({ number: 1 })]);
      expect(payload.feedback).toEqual([
        expect.objectContaining({ number: 7, approved: false, has_new_feedback: true }),
        expect.objectContaining({ number: 6, approved: true, has_new_feedback: true }),
        expect.objectContaining({ number: 3, approved: false, has_new_feedback: true }),
        expect.objectContaining({ number: 2, approved: true, has_new_feedback: false }),
      ]);
      expect(payload.metrics.reviewsNeedingApproval).toBe(1);
      const browserView = await app.inject({
        method: 'GET',
        url: `/api/browser/context?url=${encodeURIComponent('https://github.com/Acme/storage/pull/7')}`,
      });
      expect(browserView.statusCode).toBe(200);
      const afterBrowserView = await app.inject({ method: 'GET', url: '/api/dashboard' });
      expect((afterBrowserView.json() as { feedback: Array<{ number: number }> }).feedback)
        .toContainEqual(expect.objectContaining({ number: 7 }));
      const opened = await app.inject({ method: 'GET', url: '/api/reviews/github%3AAcme%2Fstorage%237' });
      expect(opened.statusCode).toBe(200);
      const afterOpen = await app.inject({ method: 'GET', url: '/api/dashboard' });
      expect((afterOpen.json() as { feedback: Array<{ number: number }> }).feedback)
        .not.toContainEqual(expect.objectContaining({ number: 7 }));
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('browser context appearance', () => {
  it('refreshes summaries written by an older summarizer once at startup', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-summary-backfill-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, simple_summary, body, url, author, head_sha,
        head_ref_name, base_ref_name, first_seen_at, updated_at, last_seen_at
      ) VALUES (
        'github:Acme/storage#88', 'Acme/storage', 88, 'Fix audit logs', 'Old clipped summary…',
        'The \`delete_audit_logs_before\` operation now returns the complete result to callers.',
        'https://github.com/Acme/storage/pull/88', 'author', 'head', 'feature', 'main', ?, ?, ?
      )
    `).run(now, now, now);
    const app = await createApp(database, new ConfigStore(config));
    try {
      expect(database.connection.prepare('SELECT simple_summary FROM review_queue WHERE number=88').get())
        .toEqual({ simple_summary: 'The `delete_audit_logs_before` operation now returns the complete result to callers.' });
      expect(database.connection.prepare("SELECT value FROM app_metadata WHERE key='review_summary_version'").get())
        .toEqual({ value: '2' });
    } finally {
      await app.close();
      database.close();
    }
  });

  it('returns app appearance settings even for an untracked pull request', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-browser-context-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const themed = structuredClone(config);
    themed.appearance = { theme: 'slayer', fontSize: 'normal', weapon: 'mace' };
    const app = await createApp(database, new ConfigStore(themed));
    try {
      const url = `/api/browser/context?url=${encodeURIComponent('https://github.com/Acme/storage/pull/999')}`;
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        appearance: { theme: 'slayer', fontSize: 'normal', weapon: 'mace' },
        review: null,
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it('refreshes the tracked PR from GitHub when the extension reports a review submission', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-browser-refresh-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        first_seen_at, updated_at, last_seen_at
      ) VALUES (
        'github:Acme/storage#1', 'Acme/storage', 1, 'Title',
        'https://github.com/Acme/storage/pull/1', 'author', 'head', 'feature', 'main', ?, ?, ?
      )
    `).run(now, now, now);
    let refreshed = 0;
    const app = await createApp(database, new ConfigStore(config), undefined, {
      refreshReview: async (db, id) => {
        refreshed += 1;
        db.connection.prepare(`
          UPDATE review_queue SET status='approved', viewer_review_state='APPROVED',
            viewer_review_sha=head_sha WHERE id=?
        `).run(id);
      },
    });
    try {
      const url = `/api/browser/context?url=${encodeURIComponent('https://github.com/Acme/storage/pull/1')}&refresh=1`;
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(refreshed).toBe(1);
      expect(response.json()).toMatchObject({
        review: {
          display_status: 'approved', viewer_review_state: 'APPROVED', viewer_review_sha: 'head',
        },
        assessment: { label: 'Approved' },
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it('adds an untracked pull request and immediately requests an agent review', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-browser-track-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    let requestedReview = '';
    const dispatcher = {
      setReviewChangedListener() {},
      requestManual(id: string) { requestedReview = id; return true; },
      async pump() {},
      cancelReview() { return { found: false, stopped: false, cancelled: 0 }; },
    } as unknown as ReviewDispatcher;
    const app = await createApp(database, new ConfigStore(config), undefined, {
      dispatcher,
      trackReview: async (db, _configured, repository, number) => {
        const now = new Date().toISOString();
        const id = `github:${repository}#${number}`;
        db.connection.prepare(`
          INSERT INTO review_queue(
            id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
            first_seen_at, updated_at, last_seen_at
          ) VALUES (?, ?, ?, 'Manual review', ?, 'author', 'head', 'feature', 'main', ?, ?, ?)
        `).run(id, repository, number, `https://github.com/${repository}/pull/${number}`, now, now, now);
        return id;
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/reviews/github%3AAcme%2Fstorage%2399/track',
        payload: {},
      });
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({ accepted: true, id: 'github:Acme/storage#99' });
      expect(requestedReview).toBe('github:Acme/storage#99');
      expect(database.connection.prepare('SELECT number FROM review_queue WHERE id=?').get(requestedReview))
        .toEqual({ number: 99 });
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('browser issue context', () => {
  it('refreshes an issue into the queue and persists its Issue Room messages', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-browser-issue-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    let refreshed = 0;
    const app = await createApp(database, new ConfigStore(config), undefined, {
      refreshIssue: async (db, _configured, repository, number) => {
        refreshed += 1;
        const now = new Date().toISOString();
        const id = `github:${repository}#${number}`;
        db.connection.prepare(`
          INSERT INTO work_items(
            id, provider, repository, number, kind, title, body, simple_summary, url,
            assignees, priority, priority_reasons, status, remote_state, payload_json,
            first_seen_at, updated_at, last_seen_at
          ) VALUES (?, 'github', ?, ?, 'issue', 'Prevent lost writes', 'Details',
            'Writes can disappear after restart; this issue tracks making them safe.', ?,
            '["cb1kenobi"]', 160, '["data integrity +150"]', 'queued', 'OPEN', '{}', ?, ?, ?)
        `).run(id, repository, number, `https://github.com/${repository}/issues/${number}`, now, now, now);
        return { id, tracked: true };
      },
    });
    try {
      const issueUrl = 'https://github.com/Acme/storage/issues/42';
      const response = await app.inject({
        method: 'GET',
        url: `/api/browser/issue-context?url=${encodeURIComponent(issueUrl)}&refresh=1`,
      });
      expect(response.statusCode).toBe(200);
      expect(refreshed).toBe(1);
      expect(response.json()).toMatchObject({
        kind: 'issue', tracked: true,
        issue: { number: 42, assignees: ['cb1kenobi'], simple_summary: expect.any(String) },
      });

      const chat = await app.inject({
        method: 'POST',
        url: '/api/issues/github%3AAcme%2Fstorage%2342/chat',
        payload: { message: 'What is the risk?', author: 'GitHub extension', askAgent: false },
      });
      expect(chat.statusCode).toBe(200);
      expect(database.connection.prepare(`
        SELECT author, content FROM issue_chat_messages WHERE work_item_id='github:Acme/storage#42'
      `).get()).toEqual({ author: 'GitHub extension', content: 'What is the risk?' });
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('local branch context', () => {
  const branchPayload = (workspacePath: string) => {
    if (!existsSync(path.join(workspacePath, '.git'))) {
      execFileSync('git', ['init', '-b', 'main'], { cwd: workspacePath });
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Acme/storage.git'], { cwd: workspacePath });
    }
    return ({
    remote: 'git@github.com:Acme/storage.git',
    branch: 'feature/local-review',
    baseBranch: 'main',
    baseRef: 'origin/main',
    headSha: '0123456789abcdef0123456789abcdef01234567',
    worktreeState: 'clean',
    workspacePath,
    });
  };

  it('persists a branch without requiring a pull request and keeps its review room', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-local-branch-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const app = await createApp(database, new ConfigStore(config));
    try {
      const context = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      expect(context.statusCode).toBe(200);
      expect(context.json()).toMatchObject({
        branch: {
          repository: 'Acme/storage', branch_name: 'feature/local-review',
          base_branch: 'main', review_id: null, status: 'unreviewed',
        },
        review: null,
        findings: [],
        messages: [],
      });
      const branch = (context.json() as { branch: { id: string } }).branch;
      const message = await app.inject({
        method: 'POST', url: `/api/local/branches/${encodeURIComponent(branch.id)}/chat`,
        payload: { message: 'Remember this branch decision.', askAgent: false, author: 'VS Code extension' },
      });
      expect(message.statusCode).toBe(200);

      const refreshed = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      expect(refreshed.json()).toMatchObject({
        messages: [{ role: 'user', author: 'VS Code extension', content: 'Remember this branch decision.' }],
      });
      const withPullRequest = await app.inject({
        method: 'POST',
        url: '/api/local/branches/context',
        payload: {
          ...branchPayload(directory),
          pullRequest: {
            repository: 'Acme/storage', number: 12, title: 'Ship the local branch',
            body: 'Adds the branch review panel.', url: 'https://github.com/Acme/storage/pull/12', author: 'developer',
          },
        },
      });
      expect(withPullRequest.json()).toMatchObject({
        review: null,
        pullRequest: {
          repository: 'Acme/storage', number: 12, title: 'Ship the local branch',
          url: 'https://github.com/Acme/storage/pull/12', author: 'developer',
        },
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it('attaches only the pull request for the same branch and promotes the room into the PR', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-local-pr-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const app = await createApp(database, new ConfigStore(config));
    try {
      const initial = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      const branch = (initial.json() as { branch: { id: string } }).branch;
      await app.inject({
        method: 'POST', url: `/api/local/branches/${encodeURIComponent(branch.id)}/chat`,
        payload: { message: 'Carry this into the PR room.', askAgent: false, author: 'VS Code extension' },
      });
      const now = new Date().toISOString();
      const insert = database.connection.prepare(`
        INSERT INTO review_queue(
          id, repository, number, title, simple_summary, url, author, head_sha, head_ref_name, base_ref_name,
          first_seen_at, updated_at, last_seen_at
        ) VALUES (?, 'Acme/storage', ?, ?, ?, ?, 'author', ?, ?, 'main', ?, ?, ?)
      `);
      insert.run(
        'github:Acme/storage#1', 1, 'Different branch', 'Wrong PR', 'https://github.com/Acme/storage/pull/1',
        branchPayload(directory).headSha, 'other-branch', now, now, now,
      );
      insert.run(
        'github:Acme/storage#3', 3, 'Stale branch head', 'Wrong PR', 'https://github.com/Acme/storage/pull/3',
        'ffffffffffffffffffffffffffffffffffffffff', 'feature/local-review', now, now, now,
      );
      insert.run(
        'github:Acme/storage#2', 2, 'Local review PR', 'The matching summary', 'https://github.com/Acme/storage/pull/2',
        branchPayload(directory).headSha, 'feature/local-review', now, now, now,
      );

      const linked = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      expect(linked.statusCode).toBe(200);
      expect(linked.json()).toMatchObject({
        branch: { review_id: 'github:Acme/storage#2' },
        review: { number: 2, title: 'Local review PR', simple_summary: 'The matching summary' },
        messages: [{ content: 'Carry this into the PR room.' }],
      });
      expect(database.connection.prepare('SELECT COUNT(*) AS total FROM local_branch_messages').get())
        .toEqual({ total: 0 });
      expect(database.connection.prepare('SELECT review_id, content FROM chat_messages').get())
        .toEqual({ review_id: 'github:Acme/storage#2', content: 'Carry this into the PR room.' });
      database.connection.prepare(`
        UPDATE review_queue SET remote_state='MERGED', status='merged' WHERE id='github:Acme/storage#2'
      `).run();
      const merged = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      expect(merged.json()).toMatchObject({
        branch: { review_id: 'github:Acme/storage#2' },
        review: { number: 2, status: 'merged' },
        messages: [{ content: 'Carry this into the PR room.' }],
      });
      const localFallback = await app.inject({
        method: 'POST',
        url: `/api/local/branches/${encodeURIComponent(branch.id)}/run-review`,
        payload: {},
      });
      expect(localFallback.statusCode).toBe(202);
      expect(localFallback.json()).toMatchObject({ target: 'branch' });
      expect(database.connection.prepare('SELECT review_id FROM local_branches WHERE id=?').get(branch.id))
        .toEqual({ review_id: 'github:Acme/storage#2' });
      await expect.poll(() => (database.connection.prepare(
        'SELECT status FROM local_branches WHERE id=?',
      ).get(branch.id) as { status: string }).status).not.toBe('agent_working');
      const roomAfterFallback = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      expect(roomAfterFallback.json()).toMatchObject({
        branch: { review_id: 'github:Acme/storage#2' },
        review: { number: 2 },
        messages: [{ content: 'Carry this into the PR room.' }],
      });
      const nextLifecycle = await app.inject({
        method: 'POST',
        url: '/api/local/branches/context',
        payload: { ...branchPayload(directory), headSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      });
      expect(nextLifecycle.json()).toMatchObject({
        branch: { review_id: null, head_sha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd' },
        review: null,
        pullRequest: null,
      });
    } finally {
      await app.close();
      database.close();
    }
  });

  it('runs a linked pull request room agent inside the editor workspace', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-linked-chat-cwd-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const current = structuredClone(config);
    current.agents.chat.provider = 'fake';
    current.agents.providers = {
      fake: { command: process.execPath, args: ['-e', 'console.log(process.cwd())'] },
    };
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        first_seen_at, updated_at, last_seen_at
      ) VALUES (
        'github:Acme/storage#7', 'Acme/storage', 7, 'Linked PR',
        'https://github.com/Acme/storage/pull/7', 'author', ?, 'feature/local-review', 'main', ?, ?, ?
      )
    `).run(branchPayload(directory).headSha, now, now, now);
    const app = await createApp(database, new ConfigStore(current));
    try {
      const context = await app.inject({
        method: 'POST', url: '/api/local/branches/context', payload: branchPayload(directory),
      });
      const branch = (context.json() as { branch: { id: string } }).branch;
      const response = await app.inject({
        method: 'POST',
        url: `/api/local/branches/${encodeURIComponent(branch.id)}/chat`,
        payload: { message: 'Where are you running?', askAgent: true, author: 'VS Code extension' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ message: { content: realpathSync(directory) } });
      expect(database.connection.prepare(`
        SELECT branch_id FROM agent_runs ORDER BY id DESC LIMIT 1
      `).get()).toEqual({ branch_id: branch.id });
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('settings API', () => {
  it('validates, persists, and activates complete config updates without exposing env settings', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-settings-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const current = structuredClone(config);
    current.agents.providers = { codex: { command: '/secret/codex', args: ['--api-key', 'sk-not-for-api'] } };
    const persisted: BarbarianConfig[] = [];
    const store = new ConfigStore(current, async (value) => { persisted.push(structuredClone(value)); return 'memory:2'; });
    const app = await createApp(database, store);
    try {
      const before = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(before.statusCode).toBe(200);
      expect(before.json()).toMatchObject({
        config: {
          appearance: { theme: 'dark', fontSize: 'small', weapon: 'double-axe' },
          agents: {
            codeReview: { provider: 'codex', model: '', effort: '' },
            chat: { provider: 'codex', model: '', effort: '' },
          },
        },
        advanced: { providers: [{ name: 'codex', supportsModel: true, supportsEffort: true }] },
        revision: 'memory:1',
        configFile: 'config/barbarian.yaml',
      });
      expect(before.body).not.toContain('envFile');
      expect(before.body).not.toContain('/secret/codex');
      expect(before.body).not.toContain('sk-not-for-api');

      const editable = (before.json() as { config: Record<string, unknown> }).config;
      const next = {
        ...editable,
        profile: { ...current.profile, name: 'Barbarian' },
        appearance: { theme: 'slayer', fontSize: 'normal', weapon: 'double-axe' },
        agents: {
          ...(editable.agents as Record<string, unknown>),
          codeReview: { provider: 'codex', model: 'gpt-review', effort: 'high' },
          chat: { provider: 'codex', model: 'gpt-chat', effort: 'medium' },
        },
        repositories: [...current.repositories, {
          name: 'Acme/ui', priority: 5, watchIssues: false, watchPullRequests: true,
          reviewSkill: 'cb1-code-review', labels: { accessibility: 25 },
        }],
      };
      const protectedFields = await app.inject({
        method: 'PUT', url: '/api/settings',
        payload: { revision: 'memory:1', config: { ...next, linear: { enabled: true, command: ['/bin/sh'] } } },
      });
      expect(protectedFields.statusCode).toBe(400);
      expect(persisted).toHaveLength(0);

      const extensionWrite = await app.inject({
        method: 'PUT', url: '/api/settings', headers: { origin: 'chrome-extension://untrusted' },
        payload: { revision: 'memory:1', config: next },
      });
      expect(extensionWrite.statusCode).toBe(403);
      expect(persisted).toHaveLength(0);

      const saved = await app.inject({ method: 'PUT', url: '/api/settings', payload: { revision: 'memory:1', config: next } });
      expect(saved.statusCode).toBe(200);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject(next);
      expect(persisted[0]!.agents.codeReview).toEqual({ provider: 'codex', model: 'gpt-review', effort: 'high' });
      expect(persisted[0]!.agents.chat).toEqual({ provider: 'codex', model: 'gpt-chat', effort: 'medium' });
      expect(persisted[0]!.agents.providers.codex).toEqual(current.agents.providers.codex);
      expect(persisted[0]!.review.workspaceRoot).toBe(current.review.workspaceRoot);
      expect(store.get()).toMatchObject({ profile: { name: 'Barbarian' }, appearance: next.appearance });
      expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(200);

      const invalid = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { revision: 'memory:2', config: { ...next, appearance: { theme: 'neon', fontSize: 'normal', weapon: 'double-axe' } } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(persisted).toHaveLength(1);
      expect(store.get().appearance.theme).toBe('slayer');

      const stale = await app.inject({ method: 'PUT', url: '/api/settings', payload: { revision: 'memory:1', config: next } });
      expect(stale.statusCode).toBe(409);
    } finally {
      await app.close();
      database.close();
    }
  });
});
