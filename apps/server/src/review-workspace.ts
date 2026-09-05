import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { BarbarianDatabase } from './database.js';
import { repositoryFromRemote } from './branch-context.js';
import { runProcess } from './process.js';

export interface ReviewWorkspace {
  branchId: string;
  branchName: string;
  path: string;
}

export async function resolveReviewWorkspace(
  database: BarbarianDatabase,
  reviewId: string,
): Promise<ReviewWorkspace | null> {
  const branch = database.connection.prepare(`
    SELECT local_branches.id, local_branches.repository, local_branches.branch_name,
      local_branches.head_sha, local_branches.workspace_path
    FROM local_branches
    JOIN review_queue ON review_queue.id=local_branches.review_id
      AND review_queue.head_sha=local_branches.head_sha
    WHERE local_branches.review_id=?
    ORDER BY local_branches.last_seen_at DESC, local_branches.id ASC LIMIT 1
  `).get(reviewId) as {
    id: string;
    repository: string;
    branch_name: string;
    head_sha: string;
    workspace_path: string;
  } | undefined;
  if (!branch) return null;

  const recordedPath = path.resolve(branch.workspace_path);
  const resolvedPath = await realpath(recordedPath).catch(() => '');
  const workspace = resolvedPath ? await stat(resolvedPath).catch(() => null) : null;
  if (resolvedPath !== recordedPath || !workspace?.isDirectory()) return null;

  const gitState = await Promise.all([
    runProcess('git', ['branch', '--show-current'], {
      cwd: resolvedPath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    }),
    runProcess('git', ['rev-parse', 'HEAD'], {
      cwd: resolvedPath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    }),
    runProcess('git', ['remote', 'get-url', 'origin'], {
      cwd: resolvedPath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    }),
  ]).catch(() => null);
  if (!gitState) return null;
  const [currentBranch, currentHead, origin] = gitState;
  if (currentBranch.exitCode !== 0 || currentBranch.stdout.trim() !== branch.branch_name) return null;
  if (currentHead.exitCode !== 0 || currentHead.stdout.trim() !== branch.head_sha) return null;
  if (origin.exitCode !== 0
    || repositoryFromRemote(origin.stdout.trim())?.toLowerCase() !== branch.repository.toLowerCase()) return null;
  return { branchId: branch.id, branchName: branch.branch_name, path: resolvedPath };
}
