import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import {
  cleanupCompletedWorkspaces, commitFeedbackWorkspace, prepareFeedbackWorkspace, pushFeedbackWorkspace,
} from './workspaces.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config = {
  version: 1,
  server: { bindAddress: '127.0.0.1', port: 4142, trustedHosts: [] },
  desktop: { launchAtLogin: false, globalShortcut: '' },
  profile: { name: 'Developer', reviewName: '', timezone: 'UTC', githubLogin: '' },
  appearance: { theme: 'dark', fontSize: 'normal', weapon: 'double-axe' },
  monitor: { intervalMinutes: 20, runOnStartup: false },
  repositories: [],
  review: { requestedReviewer: '', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    codeReview: [], chat: { provider: 'codex', model: '', effort: '' }, autoReview: false,
    autoAddressFeedback: false,
    reviewRouting: 'round_robin', usageHeadroomPercent: 20,
    maxConcurrent: 1, maxAutomaticAttempts: 1, retryBaseMinutes: 1,
    maxRunsPerPullRequestPerHour: 1, providers: {},
  },
  statusUpdate: { enabled: false, workdays: [], daysOff: [] },
} satisfies BarbarianConfig;

describe('workspace cleanup', () => {
  it('clears a migrated pointer outside the new cache root without aborting the sweep', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-workspace-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at, workspace_path
      ) VALUES ('github:Acme/storage#1', 'Acme/storage', 1, 'Closed', 'https://example.test/1',
        'author', 'abcdef1', 'feature', 'main', 'closed', ?, ?, ?, '/legacy/repo/.barbarian/workspaces/pulls/pr1')
    `).run(now, now, now);

    await expect(cleanupCompletedWorkspaces(database, config)).resolves.toBe(1);
    expect(database.connection.prepare('SELECT workspace_path FROM review_queue').get())
      .toEqual({ workspace_path: null });
    database.close();
  });

  it('removes a completed feedback clone without treating it as a linked worktree', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-feedback-cleanup-'));
    directories.push(directory);
    const feedbackWorkspace = path.join(directory, 'feedback', 'Acme-storage-pr1');
    execFileSync('mkdir', ['-p', feedbackWorkspace]);
    writeFileSync(path.join(feedbackWorkspace, 'artifact.txt'), 'managed scratch data\n');
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at, feedback_workspace_path
      ) VALUES ('github:Acme/storage#1', 'Acme/storage', 1, 'Closed', 'https://example.test/1',
        'author', 'abcdef1', 'feature', 'main', 'closed', ?, ?, ?, ?)
    `).run(now, now, now, feedbackWorkspace);
    const cleanupConfig = { ...config, review: { ...config.review, workspaceRoot: directory } };

    await expect(cleanupCompletedWorkspaces(database, cleanupConfig)).resolves.toBe(1);
    expect(database.connection.prepare('SELECT feedback_workspace_path FROM review_queue').get())
      .toEqual({ feedback_workspace_path: null });
    database.close();
  });

  it('continues cleanup when one recorded feedback workspace is unrecognized', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-cleanup-continue-'));
    directories.push(directory);
    const root = path.join(directory, 'managed');
    const unrecognized = path.join(directory, 'external-worktree');
    const managed = path.join(root, 'feedback', 'Acme-storage-pr2');
    execFileSync('mkdir', ['-p', unrecognized, managed]);
    writeFileSync(path.join(unrecognized, '.git'), 'gitdir: /not/a/managed/worktree\n');
    writeFileSync(path.join(managed, 'artifact.txt'), 'managed scratch data\n');
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    const insert = database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at, feedback_workspace_path
      ) VALUES (?, 'Acme/storage', ?, 'Closed', ?, 'author', 'abcdef1', 'feature', 'main',
        'closed', ?, ?, ?, ?)
    `);
    insert.run('github:Acme/storage#1', 1, 'https://example.test/1', now, now, now, unrecognized);
    insert.run('github:Acme/storage#2', 2, 'https://example.test/2', now, now, now, managed);
    const cleanupConfig = { ...config, review: { ...config.review, workspaceRoot: root } };

    await expect(cleanupCompletedWorkspaces(database, cleanupConfig)).resolves.toBe(1);
    expect(existsSync(managed)).toBe(false);
    expect(database.connection.prepare('SELECT feedback_workspace_path FROM review_queue WHERE id=?').get('github:Acme/storage#1'))
      .toEqual({ feedback_workspace_path: unrecognized });
    expect(database.connection.prepare('SELECT feedback_workspace_path FROM review_queue WHERE id=?').get('github:Acme/storage#2'))
      .toEqual({ feedback_workspace_path: null });
    database.close();
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function optionalGit(cwd: string, ...args: string[]): string {
  try { return git(cwd, ...args); }
  catch { return ''; }
}

function feedbackRepository(): { directory: string; workspace: string; initialHead: string } {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-feedback-git-'));
  directories.push(directory);
  const source = path.join(directory, 'source');
  const remote = path.join(directory, 'remote.git');
  const workspace = path.join(directory, 'workspace');
  execFileSync('git', ['init', '-b', 'main', source]);
  git(source, 'config', 'user.name', 'Test User');
  git(source, 'config', 'user.email', 'test@example.test');
  writeFileSync(path.join(source, 'file.txt'), 'initial\n');
  git(source, 'add', 'file.txt');
  git(source, 'commit', '-m', 'initial');
  execFileSync('git', ['clone', '--bare', source, remote]);
  execFileSync('git', ['clone', remote, workspace]);
  git(workspace, 'config', 'user.name', 'Test User');
  git(workspace, 'config', 'user.email', 'test@example.test');
  git(workspace, 'switch', '-c', 'feature');
  writeFileSync(path.join(workspace, 'file.txt'), 'feature\n');
  git(workspace, 'add', 'file.txt');
  git(workspace, 'commit', '-m', 'feature');
  const initialHead = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'push', 'origin', 'HEAD:refs/heads/feature');
  git(workspace, 'remote', 'set-url', 'origin', 'git@github.com:Acme/storage.git');
  git(workspace, 'config', `url.file://${remote}.insteadOf`, 'git@github.com:Acme/storage.git');
  git(workspace, 'config', '--replace-all', 'remote.origin.pushurl', 'barbarian-disabled://server-verified-push-only');
  return { directory, workspace, initialHead };
}

describe('feedback workspace push', () => {
  it('uses a configured repository for an isolated guarded worktree lifecycle', async () => {
    const { directory, workspace: repository, initialHead } = feedbackRepository();
    git(repository, 'config', '--unset-all', 'remote.origin.pushurl');
    rmSync(path.join(repository, '.git', 'info', 'exclude'));
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    const reviewId = 'github:Acme/storage#1';
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at
      ) VALUES (?, 'Acme/storage', 1, 'Feedback', 'https://example.test/1',
        'author', ?, 'feature', 'main', 'unreviewed', ?, ?, ?)
    `).run(reviewId, initialHead, now, now, now);
    const localConfig = {
      ...config,
      repositories: [{
        name: 'Acme/storage', path: repository, priority: 0,
        watchIssues: true, watchPullRequests: true,
        reviewSkill: 'cb1-code-review', feedbackSkill: 'harper-engineering-guidelines', labels: {},
      }],
      review: { ...config.review, workspaceRoot: path.join(directory, 'cache') },
    } satisfies BarbarianConfig;
    const before = {
      head: git(repository, 'rev-parse', 'HEAD'),
      status: git(repository, 'status', '--porcelain'),
      origin: git(repository, 'remote', 'get-url', 'origin'),
      pushUrl: optionalGit(repository, 'config', '--get-all', 'remote.origin.pushurl'),
    };

    const prepared = await prepareFeedbackWorkspace(database, localConfig, reviewId);
    expect(prepared).toEqual({
      path: path.join(realpathSync(repository), '.claude', 'worktrees', 'barbarian-feedback-pr1'),
      initialHeadSha: initialHead,
      pushGuard: 'sandbox',
    });
    expect(readFileSync(path.join(repository, '.git', 'info', 'exclude'), 'utf8'))
      .toContain('.claude/worktrees/');
    expect(git(repository, 'status', '--porcelain')).toBe('');

    writeFileSync(path.join(prepared.path, 'file.txt'), 'partial fix\n');
    writeFileSync(path.join(prepared.path, 'scratch.txt'), 'scratch\n');
    const retried = await prepareFeedbackWorkspace(database, localConfig, reviewId);
    expect(retried).toEqual(prepared);
    expect(git(prepared.path, 'status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(prepared.path, 'file.txt'), 'utf8')).toBe('feature\n');

    writeFileSync(path.join(prepared.path, 'file.txt'), 'fixed\n');
    const committedHead = await commitFeedbackWorkspace(prepared.path, initialHead, 'Address feedback');
    await expect(pushFeedbackWorkspace(
      prepared.path, 'Acme/storage', 'feature', initialHead, undefined, prepared.pushGuard,
    )).resolves.toBe(committedHead);
    database.connection.prepare("UPDATE review_queue SET status='merged' WHERE id=?").run(reviewId);
    await expect(cleanupCompletedWorkspaces(database, localConfig)).resolves.toBe(1);

    expect(existsSync(prepared.path)).toBe(false);
    expect(git(repository, 'worktree', 'list', '--porcelain')).not.toContain(prepared.path);
    expect(() => git(repository, 'show-ref', '--verify', 'refs/barbarian/feedback/1')).toThrow();
    expect({
      head: git(repository, 'rev-parse', 'HEAD'),
      status: git(repository, 'status', '--porcelain'),
      origin: git(repository, 'remote', 'get-url', 'origin'),
      pushUrl: optionalGit(repository, 'config', '--get-all', 'remote.origin.pushurl'),
    }).toEqual(before);
    database.close();
  });

  it('rejects a configured repository whose origin does not match', async () => {
    const { directory, workspace: repository, initialHead } = feedbackRepository();
    const database = new BarbarianDatabase(path.join(directory, 'mismatch.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at
      ) VALUES ('github:Other/storage#2', 'Other/storage', 2, 'Feedback', 'https://example.test/2',
        'author', ?, 'feature', 'main', 'unreviewed', ?, ?, ?)
    `).run(initialHead, now, now, now);
    const mismatchConfig = {
      ...config,
      repositories: [{
        name: 'Other/storage', path: repository, priority: 0,
        watchIssues: true, watchPullRequests: true,
        reviewSkill: 'cb1-code-review', feedbackSkill: '', labels: {},
      }],
    } satisfies BarbarianConfig;

    await expect(prepareFeedbackWorkspace(database, mismatchConfig, 'github:Other/storage#2'))
      .rejects.toThrow('origin does not match Other/storage');
    database.close();
  });

  it('refuses to reuse an ordinary directory nested at the managed worktree path', async () => {
    const { directory, workspace: repository, initialHead } = feedbackRepository();
    git(repository, 'config', '--unset-all', 'remote.origin.pushurl');
    const deceptiveWorkspace = path.join(repository, '.claude', 'worktrees', 'barbarian-feedback-pr3');
    execFileSync('mkdir', ['-p', deceptiveWorkspace]);
    writeFileSync(path.join(deceptiveWorkspace, 'untracked.txt'), 'must survive\n');
    const database = new BarbarianDatabase(path.join(directory, 'ordinary-directory.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at
      ) VALUES ('github:Acme/storage#3', 'Acme/storage', 3, 'Feedback', 'https://example.test/3',
        'author', ?, 'feature', 'main', 'unreviewed', ?, ?, ?)
    `).run(initialHead, now, now, now);
    const localConfig = {
      ...config,
      repositories: [{
        name: 'Acme/storage', path: repository, priority: 0,
        watchIssues: true, watchPullRequests: true,
        reviewSkill: 'cb1-code-review', feedbackSkill: '', labels: {},
      }],
    } satisfies BarbarianConfig;

    await expect(prepareFeedbackWorkspace(database, localConfig, 'github:Acme/storage#3'))
      .rejects.toThrow('not a recognized linked Git worktree');
    expect(readFileSync(path.join(deceptiveWorkspace, 'untracked.txt'), 'utf8')).toBe('must survive\n');
    expect(git(repository, 'rev-parse', 'HEAD')).toBe(initialHead);
    database.close();
  });

  it('lets Barbarian create the commit after a sandboxed agent leaves working-tree edits', async () => {
    const { workspace, initialHead } = feedbackRepository();
    writeFileSync(path.join(workspace, 'fix.txt'), 'fixed\n');

    const committedHead = await commitFeedbackWorkspace(
      workspace, initialHead, 'Address review feedback',
    );

    expect(committedHead).not.toBe(initialHead);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workspace, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: workspace, encoding: 'utf8' }).trim())
      .toBe('Address review feedback');
  });

  it('rejects whitespace errors even when the agent staged them', async () => {
    const { workspace, initialHead } = feedbackRepository();
    writeFileSync(path.join(workspace, 'staged.txt'), 'trailing whitespace  \n');
    git(workspace, 'add', 'staged.txt');

    await expect(commitFeedbackWorkspace(workspace, initialHead, 'Address review feedback'))
      .rejects.toThrow('whitespace');
  });

  it('pushes a clean descendant only while the remote branch still matches the claim', async () => {
    const { workspace, initialHead } = feedbackRepository();
    writeFileSync(path.join(workspace, 'file.txt'), 'fixed\n');
    git(workspace, 'add', 'file.txt');
    git(workspace, 'commit', '-m', 'fix feedback');
    const newHead = git(workspace, 'rev-parse', 'HEAD');

    await expect(pushFeedbackWorkspace(workspace, 'Acme/storage', 'feature', initialHead))
      .resolves.toBe(newHead);
    expect(git(workspace, 'ls-remote', '--heads', 'origin', 'refs/heads/feature').split(/\s+/)[0])
      .toBe(newHead);
  });

  it('rejects dirty, unchanged, and remotely advanced workspaces', async () => {
    const { workspace, initialHead } = feedbackRepository();
    writeFileSync(path.join(workspace, 'dirty.txt'), 'dirty\n');
    await expect(pushFeedbackWorkspace(workspace, 'Acme/storage', 'feature', initialHead))
      .rejects.toThrow('uncommitted changes');
    git(workspace, 'clean', '-fd');
    await expect(pushFeedbackWorkspace(workspace, 'Acme/storage', 'feature', initialHead))
      .rejects.toThrow('did not create a commit');

    writeFileSync(path.join(workspace, 'file.txt'), 'local fix\n');
    git(workspace, 'add', 'file.txt');
    git(workspace, 'commit', '-m', 'local fix');
    const remote = git(workspace, 'config', `url.file://${path.join(path.dirname(workspace), 'remote.git')}.insteadOf`);
    expect(remote).toBe('git@github.com:Acme/storage.git');
    execFileSync('git', [
      '--git-dir', path.join(path.dirname(workspace), 'remote.git'), 'update-ref', 'refs/heads/feature',
      git(workspace, 'rev-parse', 'refs/remotes/origin/main'),
    ]);
    await expect(pushFeedbackWorkspace(workspace, 'Acme/storage', 'feature', initialHead))
      .rejects.toThrow('branch changed');
  });
});
