import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import {
  cleanupCompletedWorkspaces, commitFeedbackWorkspace, pushFeedbackWorkspace,
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
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
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
