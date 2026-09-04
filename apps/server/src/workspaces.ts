import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { resolveProjectPath } from './config.js';
import { runProcess } from './process.js';
import { recordActivity } from './activity.js';

interface ReviewWorkspaceRow {
  id: string;
  repository: string;
  number: number;
  head_sha: string;
  workspace_path: string | null;
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
    SELECT id, repository, number, head_sha, workspace_path FROM review_queue WHERE id=?
  `).get(id) as ReviewWorkspaceRow | undefined;
  if (!row) throw new Error('Pull request is not in the review queue');
  return row;
}

async function checked(command: string, args: string[], cwd?: string, timeoutMs = 15 * 60_000): Promise<string> {
  const result = await runProcess(command, args, cwd === undefined ? { timeoutMs } : { cwd, timeoutMs });
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

export async function cleanupWorkspace(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
): Promise<void> {
  const review = getReview(database, reviewId);
  if (!review.workspace_path) return;
  const root = resolveProjectPath(config.review.workspaceRoot);
  const [owner, repo] = review.repository.split('/');
  if (!owner || !repo) throw new Error('Invalid repository name');
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
  database.connection.prepare('UPDATE review_queue SET workspace_path=NULL, updated_at=? WHERE id=?')
    .run(new Date().toISOString(), reviewId);
  recordActivity(database, 'workspace_cleaned', `Cleaned workspace for ${review.repository}#${review.number}`, reviewId);
}

export async function cleanupCompletedWorkspaces(database: BarbarianDatabase, config: BarbarianConfig): Promise<number> {
  const rows = database.connection.prepare(`
    SELECT id FROM review_queue WHERE workspace_path IS NOT NULL AND status IN ('merged','closed')
  `).all() as Array<{ id: string }>;
  for (const row of rows) await cleanupWorkspace(database, config, row.id);
  return rows.length;
}
