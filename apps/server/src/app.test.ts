import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { BarbarianConfig } from './types.js';
import { BarbarianDatabase } from './database.js';
import { ConfigStore } from './config.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config: BarbarianConfig = {
  version: 1,
  profile: { name: 'Chris', timezone: 'America/Chicago', githubLogin: 'cb1kenobi' },
  appearance: { theme: 'dark', fontSize: 'small' },
  monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
  repositories: [{ name: 'Acme/storage', priority: 10, watchIssues: true, watchPullRequests: true, reviewSkill: 'cb1-code-review', labels: {} }],
  review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    default: 'codex', autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: {},
  },
  statusUpdate: { enabled: false, workdays: [], daysOff: [] },
};

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
        linked_issues='[12,34]', body='Fixes ENG-9' WHERE number=1
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
        activeReviews: Array<Record<string, unknown>>;
        metrics: { needsAttention: number; queuedIssues: number; reviewsNeedingApproval: number };
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
      expect(payload.activeReviews).toEqual([expect.objectContaining({
        repository: 'Acme/storage', number: 2, agent: 'codex', model: 'CLI default',
        started_at: '2026-01-02T05:00:00Z',
      }), expect.objectContaining({
        repository: 'Acme/storage', number: 3, agent: 'codex', model: 'CLI default',
        started_at: '2026-01-02T05:30:00Z',
      }), expect.objectContaining({
        repository: 'Acme/storage', number: 4, agent: 'codex', model: 'CLI default',
        started_at: '2026-01-02T06:00:01Z',
      })]);
      expect(payload.metrics).toMatchObject({
        needsAttention: 515,
        queuedIssues: 15,
        reviewsNeedingApproval: 500,
      });
      expect(reviews.find((review) => review.number === 1)).toMatchObject({
        remote_updated_at: '2026-01-02T03:04:00Z',
        last_agent_review_at: '2026-01-02T04:05:00Z',
        issue_counts: { high: 1, medium: 0, low: 1 },
        fixed_issues: [
          { provider: 'github', identifier: '#12', url: 'https://github.com/Acme/storage/issues/12' },
          { provider: 'github', identifier: '#34', url: 'https://github.com/Acme/storage/issues/34' },
          { provider: 'linear', identifier: 'ENG-9', url: null },
        ],
      });
      expect(payload.statusDraft.lines).toHaveLength(7);
      expect(payload.statusDraft.lines.slice(0, 4).every((line) => line.startsWith('* storage: Issue'))).toBe(true);
      expect(payload.statusDraft.lines.slice(4).every((line) => line.startsWith('* storage: Reviewing #'))).toBe(true);
      expect(payload.statusDraft.lines.every((line) => !line.includes(' - '))).toBe(true);
    } finally {
      await app.close();
      database.close();
    }
  });
});

describe('browser context appearance', () => {
  it('returns app appearance settings even for an untracked pull request', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-browser-context-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const themed = structuredClone(config);
    themed.appearance = { theme: 'slayer', fontSize: 'normal' };
    const app = await createApp(database, new ConfigStore(themed));
    try {
      const url = `/api/browser/context?url=${encodeURIComponent('https://github.com/Acme/storage/pull/999')}`;
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        appearance: { theme: 'slayer', fontSize: 'normal' },
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
  const branchPayload = (workspacePath: string) => ({
    remote: 'git@github.com:Acme/storage.git',
    branch: 'feature/local-review',
    baseBranch: 'main',
    baseRef: 'origin/main',
    headSha: '0123456789abcdef0123456789abcdef01234567',
    worktreeState: 'clean',
    workspacePath,
  });

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
        config: { appearance: { theme: 'dark', fontSize: 'small' } },
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
        appearance: { theme: 'slayer', fontSize: 'normal' },
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
      expect(persisted[0]!.agents.providers).toEqual(current.agents.providers);
      expect(persisted[0]!.review.workspaceRoot).toBe(current.review.workspaceRoot);
      expect(store.get()).toMatchObject({ profile: { name: 'Barbarian' }, appearance: next.appearance });
      expect((await app.inject({ method: 'GET', url: '/api/dashboard' })).statusCode).toBe(200);

      const invalid = await app.inject({
        method: 'PUT', url: '/api/settings', payload: { revision: 'memory:2', config: { ...next, appearance: { theme: 'neon', fontSize: 'normal' } } },
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
