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

const agentControlPathspecs = [
  ':(glob)AGENTS.md', ':(glob)**/AGENTS.md',
  ':(glob)CLAUDE.md', ':(glob)**/CLAUDE.md',
  ':(glob).cursorrules', ':(glob)**/.cursorrules',
  ':(glob).cursor/**', ':(glob)**/.cursor/**',
  ':(glob).codex/**', ':(glob)**/.codex/**',
  ':(glob).agents/**', ':(glob)**/.agents/**',
];

async function hasUntrustedAgentControls(workspacePath: string, baseBranch: string): Promise<boolean | null> {
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const localRef = `refs/heads/${baseBranch}`;
  const remoteBase = await runProcess('git', ['rev-parse', '--verify', remoteRef], {
    cwd: workspacePath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
  });
  let baseRef = remoteRef;
  if (remoteBase.exitCode !== 0) {
    const localBase = await runProcess('git', ['rev-parse', '--verify', localRef], {
      cwd: workspacePath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    });
    if (localBase.exitCode !== 0) return null;
    baseRef = localRef;
  }
  const checks = await Promise.all([
    runProcess('git', ['diff', '--quiet', `${baseRef}...HEAD`, '--', ...agentControlPathspecs], {
      cwd: workspacePath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    }),
    runProcess('git', ['diff', '--quiet', 'HEAD', '--', ...agentControlPathspecs], {
      cwd: workspacePath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    }),
    runProcess('git', ['ls-files', '--others', '--exclude-standard', '--', ...agentControlPathspecs], {
      cwd: workspacePath, timeoutMs: 5_000, maxOutputCharacters: 2_000,
    }),
  ]);
  if (checks[0]!.exitCode > 1 || checks[1]!.exitCode > 1 || checks[2]!.exitCode !== 0) return null;
  return checks[0]!.exitCode === 1 || checks[1]!.exitCode === 1 || Boolean(checks[2]!.stdout.trim());
}

export async function resolveReviewWorkspace(
  database: BarbarianDatabase,
  reviewId: string,
): Promise<ReviewWorkspace | null> {
  const branch = database.connection.prepare(`
    SELECT local_branches.id, local_branches.repository, local_branches.branch_name,
      local_branches.head_sha, local_branches.workspace_path, review_queue.base_ref_name
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
    base_ref_name: string;
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
  const untrustedAgentControls = await hasUntrustedAgentControls(resolvedPath, branch.base_ref_name).catch(() => null);
  if (untrustedAgentControls !== false) return null;
  return { branchId: branch.id, branchName: branch.branch_name, path: resolvedPath };
}
