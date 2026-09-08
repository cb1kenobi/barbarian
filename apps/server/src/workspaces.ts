import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { resolveProjectPath } from './config.js';
import { runProcess } from './process.js';
import { recordActivity } from './activity.js';
import { repositoryFromRemote } from './branch-context.js';

interface ReviewWorkspaceRow {
  id: string;
  repository: string;
  number: number;
  head_sha: string;
  workspace_path: string | null;
  feedback_workspace_path: string | null;
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Refusing to operate outside the configured workspace root');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function getReview(database: BarbarianDatabase, id: string): ReviewWorkspaceRow {
  const row = database.connection.prepare(`
    SELECT id, repository, number, head_sha, workspace_path, feedback_workspace_path FROM review_queue WHERE id=?
  `).get(id) as ReviewWorkspaceRow | undefined;
  if (!row) throw new Error('Pull request is not in the review queue');
  return row;
}

async function checked(
  command: string,
  args: string[],
  cwd?: string,
  timeoutMs = 15 * 60_000,
  signal?: AbortSignal,
): Promise<string> {
  const options = { timeoutMs, ...(signal ? { signal } : {}), ...(cwd === undefined ? {} : { cwd }) };
  const result = await runProcess(command, args, options);
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${command} exited ${result.exitCode}`);
  return result.stdout;
}

async function installAndBuild(worktree: string): Promise<void> {
  if (!existsSync(path.join(worktree, 'package.json'))) return;
  if (existsSync(path.join(worktree, 'pnpm-lock.yaml'))) await checked('pnpm', ['install', '--frozen-lockfile'], worktree);
  else if (existsSync(path.join(worktree, 'package-lock.json'))) await checked('npm', ['ci'], worktree);
  else if (existsSync(path.join(worktree, 'yarn.lock'))) await checked('yarn', ['install', '--frozen-lockfile'], worktree);
  else await checked('npm', ['install'], worktree);
  const pkg = JSON.parse(await readFile(path.join(worktree, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  if (pkg.scripts?.build) {
    if (existsSync(path.join(worktree, 'pnpm-lock.yaml'))) await checked('pnpm', ['run', 'build'], worktree);
    else if (existsSync(path.join(worktree, 'yarn.lock'))) await checked('yarn', ['build'], worktree);
    else await checked('npm', ['run', 'build'], worktree);
  }
}

export async function prepareWorkspace(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
): Promise<string> {
  const review = getReview(database, reviewId);
  const root = resolveProjectPath(config.review.workspaceRoot);
  const [owner, repo] = review.repository.split('/');
  if (!owner || !repo) throw new Error('Invalid repository name');
  const clone = path.join(root, 'repos', owner, repo);
  const worktree = path.join(root, 'pulls', `${owner}-${repo}-pr${review.number}-${review.head_sha.slice(0, 8)}`);
  assertWithin(root, clone);
  assertWithin(root, worktree);

  if (!existsSync(path.join(clone, '.git'))) {
    await checked('gh', ['repo', 'clone', review.repository, clone]);
  } else {
    await checked('git', ['fetch', '--prune', 'origin'], clone);
  }
  await checked('git', ['fetch', 'origin', `+pull/${review.number}/head:refs/barbarian/pr/${review.number}`], clone);
  await checked('git', ['worktree', 'prune'], clone);
  if (!existsSync(worktree)) {
    await checked('git', ['worktree', 'add', '--detach', worktree, `refs/barbarian/pr/${review.number}`], clone);
  }
  database.connection.prepare('UPDATE review_queue SET workspace_path=?, updated_at=? WHERE id=?')
    .run(worktree, new Date().toISOString(), reviewId);
  await installAndBuild(worktree);
  recordActivity(database, 'workspace_prepared', `Prepared ${review.repository}#${review.number} for local review`, reviewId, { worktree });
  return worktree;
}

export interface FeedbackWorkspace {
  path: string;
  initialHeadSha: string;
}

export interface FeedbackWorkspaceSource {
  repository: string;
  headRefName: string;
  headSha: string;
}

const disabledFeedbackPushUrl = 'barbarian-disabled://server-verified-push-only';

export async function commitFeedbackWorkspace(
  workspace: string,
  expectedHead: string,
  message: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const currentHead = (await checked('git', ['rev-parse', 'HEAD'], workspace)).trim();
  if (currentHead !== expectedHead) throw new Error('The feedback agent changed Git history instead of leaving a working-tree fix');
  const status = await checked('git', ['status', '--porcelain'], workspace);
  if (!status.trim()) throw new Error('The feedback agent reported a fix but did not change any files');
  await checked('git', ['diff', '--check'], workspace);
  await checked('git', ['add', '--all'], workspace);
  signal?.throwIfAborted();
  await checked('git', [
    '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null',
    'commit', '-m', message,
  ], workspace, 15 * 60_000, signal);
  const committedHead = (await checked('git', ['rev-parse', 'HEAD'], workspace)).trim();
  if (committedHead === expectedHead) throw new Error('Barbarian could not commit the feedback fix');
  const committedStatus = await checked('git', ['status', '--porcelain'], workspace);
  if (committedStatus.trim()) throw new Error('The feedback workspace was not clean after Barbarian committed the fix');
  return committedHead;
}

export async function prepareFeedbackWorkspace(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
  requestedSource?: FeedbackWorkspaceSource,
): Promise<FeedbackWorkspace> {
  const review = database.connection.prepare(`
    SELECT id, repository, number, head_sha, head_ref_name FROM review_queue WHERE id=?
  `).get(reviewId) as (ReviewWorkspaceRow & { head_ref_name: string }) | undefined;
  if (!review) throw new Error('Pull request is not in the review queue');
  const source = requestedSource || {
    repository: review.repository,
    headRefName: review.head_ref_name,
    headSha: review.head_sha,
  };
  const root = resolveProjectPath(config.review.workspaceRoot);
  const [owner, repo] = review.repository.split('/');
  if (!owner || !repo) throw new Error('Invalid repository name');
  const workspace = path.join(root, 'feedback', `${owner}-${repo}-pr${review.number}`);
  assertWithin(root, workspace);

  let cloneFresh = !existsSync(path.join(workspace, '.git'));
  if (!cloneFresh) {
    try {
      const origin = (await checked('git', ['config', '--get', 'remote.origin.url'], workspace)).trim();
      if (repositoryFromRemote(origin)?.toLowerCase() !== source.repository.toLowerCase()) {
        throw new Error('origin mismatch');
      }
      await checked('git', ['reset', '--hard'], workspace);
      await checked('git', ['clean', '-fd'], workspace);
    } catch {
      await rm(workspace, { recursive: true, force: true });
      cloneFresh = true;
    }
  }
  if (cloneFresh) {
    if (existsSync(workspace)) await rm(workspace, { recursive: true, force: true });
    await checked('gh', ['repo', 'clone', source.repository, workspace]);
  }
  await checked('git', [
    'fetch', 'origin', `+refs/heads/${source.headRefName}:refs/barbarian/feedback/${review.number}`,
  ], workspace);
  await checked('git', ['checkout', '--detach', `refs/barbarian/feedback/${review.number}`], workspace);
  await checked('git', ['config', '--replace-all', 'remote.origin.pushurl', disabledFeedbackPushUrl], workspace);
  const actualHead = (await checked('git', ['rev-parse', 'HEAD'], workspace)).trim();
  if (actualHead !== source.headSha) throw new Error('Pull request head changed while preparing the feedback workspace');
  database.connection.prepare('UPDATE review_queue SET feedback_workspace_path=?, updated_at=? WHERE id=?')
    .run(workspace, new Date().toISOString(), reviewId);
  recordActivity(database, 'feedback_workspace_prepared', `Prepared ${review.repository}#${review.number} for feedback fixes`, reviewId, { workspace });
  return { path: workspace, initialHeadSha: actualHead };
}

export async function pushFeedbackWorkspace(
  workspace: string,
  repository: string,
  headRefName: string,
  expectedRemoteHead: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const origin = (await checked('git', ['config', '--get', 'remote.origin.url'], workspace)).trim();
  if (repositoryFromRemote(origin)?.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('The feedback workspace origin changed before the fix could be pushed');
  }
  const pushUrl = (await checked('git', ['config', '--get-all', 'remote.origin.pushurl'], workspace)).trim();
  if (pushUrl !== disabledFeedbackPushUrl) {
    throw new Error('The feedback workspace push protection changed before the fix could be pushed');
  }
  const status = await checked('git', ['status', '--porcelain'], workspace);
  if (status.trim()) throw new Error('The feedback agent left uncommitted changes in its workspace');
  const newHead = (await checked('git', ['rev-parse', 'HEAD'], workspace)).trim();
  if (newHead === expectedRemoteHead) throw new Error('The feedback agent reported a fix but did not create a commit');
  const remote = (await checked(
    'git', ['ls-remote', '--heads', 'origin', `refs/heads/${headRefName}`], workspace,
  )).trim().split(/\s+/)[0] || '';
  if (remote !== expectedRemoteHead) {
    throw new Error('The pull request branch changed while the feedback fix was running');
  }
  signal?.throwIfAborted();
  await checked('git', ['config', '--unset-all', 'remote.origin.pushurl'], workspace);
  try {
    await checked('git', [
      '-c', 'core.hooksPath=/dev/null', 'push', 'origin', `${newHead}:refs/heads/${headRefName}`,
    ], workspace, 15 * 60_000, signal);
  } finally {
    await checked('git', ['config', '--replace-all', 'remote.origin.pushurl', disabledFeedbackPushUrl], workspace);
  }
  return newHead;
}

export async function inspectFeedbackWorkspace(workspace: string): Promise<{ clean: boolean; headSha: string }> {
  const [status, headSha] = await Promise.all([
    checked('git', ['status', '--porcelain'], workspace),
    checked('git', ['rev-parse', 'HEAD'], workspace),
  ]);
  return { clean: !status.trim(), headSha: headSha.trim() };
}

export async function cleanupWorkspace(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
): Promise<void> {
  const review = getReview(database, reviewId);
  if (!review.workspace_path && !review.feedback_workspace_path) return;
  const root = resolveProjectPath(config.review.workspaceRoot);
  const [owner, repo] = review.repository.split('/');
  if (!owner || !repo) throw new Error('Invalid repository name');
  if (review.feedback_workspace_path) {
    assertWithin(root, review.feedback_workspace_path);
    await rm(review.feedback_workspace_path, { recursive: true, force: true });
    database.connection.prepare('UPDATE review_queue SET feedback_workspace_path=NULL, updated_at=? WHERE id=?')
      .run(new Date().toISOString(), reviewId);
  }
  if (!review.workspace_path) {
    recordActivity(database, 'workspace_cleaned', `Cleaned workspace for ${review.repository}#${review.number}`, reviewId);
    return;
  }
  if (!isWithin(root, review.workspace_path)) {
    database.connection.prepare('UPDATE review_queue SET workspace_path=NULL, updated_at=? WHERE id=?')
      .run(new Date().toISOString(), reviewId);
    recordActivity(database, 'workspace_abandoned', `Cleared legacy workspace pointer for ${review.repository}#${review.number}`, reviewId, {
      workspace: review.workspace_path,
    });
    return;
  }
  const clone = path.join(root, 'repos', owner, repo);
  assertWithin(root, clone);
  if (existsSync(path.join(clone, '.git')) && existsSync(review.workspace_path)) {
    await checked('git', ['worktree', 'remove', '--force', review.workspace_path], clone);
  }
  if (existsSync(path.join(clone, '.git'))) {
    await checked('git', ['update-ref', '-d', `refs/barbarian/pr/${review.number}`], clone);
    await checked('git', ['worktree', 'prune'], clone);
  }
  database.connection.prepare('UPDATE review_queue SET workspace_path=NULL, feedback_workspace_path=NULL, updated_at=? WHERE id=?')
    .run(new Date().toISOString(), reviewId);
  recordActivity(database, 'workspace_cleaned', `Cleaned workspace for ${review.repository}#${review.number}`, reviewId);
}

export async function cleanupCompletedWorkspaces(database: BarbarianDatabase, config: BarbarianConfig): Promise<number> {
  const rows = database.connection.prepare(`
    SELECT id FROM review_queue
    WHERE (workspace_path IS NOT NULL OR feedback_workspace_path IS NOT NULL) AND status IN ('merged','closed')
  `).all() as Array<{ id: string }>;
  for (const row of rows) await cleanupWorkspace(database, config, row.id);
  return rows.length;
}
