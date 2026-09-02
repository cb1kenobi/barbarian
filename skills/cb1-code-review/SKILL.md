---
name: cb1-code-review
description: Generic, high-signal code review for GitHub pull requests, local branches, and uncommitted diffs. Use when asked to review code before merge for correctness, security, performance, compatibility, regressions, or unnecessary complexity. Uses Barbarian for durable queue state and never creates or updates implementation pull requests.
metadata:
  author: Chris Barber
  tags: code-review, pull-request, security, correctness, barbarian
  version: 2.1.0
---

# CB1 Code Review

Review code without changing it. This skill may read, build, test, and post review comments when the user asked for a PR review. It must not edit the reviewed branch, create commits, push, open a pull request, merge, or approve unless the user separately asks for that action.

## Resolve the target

- PR URL or `owner/repo#number`: from this skill directory, run `node scripts/review-context.mjs <target>` and write stdout to a unique temporary file created for this review. Do not share a fixed context filename because reviews may run concurrently. The script collects intent, linked issues, existing discussion, changed files, and a head-consistent diff through the authenticated GitHub CLI.
- Current PR: resolve it with `gh pr view --json url`, then use the script.
- Local branch: identify the remote default branch, compute its merge base with `HEAD`, and review that range.
- Uncommitted changes: review in place. Do not attempt to put uncommitted state in a worktree.

Read the target repository's applicable `AGENTS.md`, `CONTRIBUTING.md`, README, and local conventions before judging the change. Then read [rules/review-process.md](rules/review-process.md) and [rules/severity.md](rules/severity.md), consulting the relevant sections of [rules/language-focus.md](rules/language-focus.md). For a PR whose tests need to run, use [rules/worktree.md](rules/worktree.md). When Barbarian launched the review automatically, also read [rules/monitoring.md](rules/monitoring.md).

## Review posture

1. Establish the goal and linked-ticket requirements before judging code.
2. Read every changed hunk. For large changes, divide by coherent file groups and reconcile coverage.
3. Trace candidate findings through surrounding code and callers. Report verified problems, not pattern matches.
4. Check correctness, failure cleanup, security boundaries, concurrency, event-loop or hot-path cost, compatibility, tests, docs, and whether the solution is simpler than it needs to be.
5. Check existing GitHub review discussion before posting. Never repeat a problem someone already raised.
6. Report only problems introduced by the change or made materially worse by it. Do not turn the review into a backlog of unrelated pre-existing issues.
7. Run the narrowest relevant tests when practical. State exactly what ran and what could not run.

Default to one pass. If the user asks for deep, thorough, multipass, release, or cross-model review, use the available cross-model review workflow and union only independently verified findings.

## Findings

Order findings by severity: Critical, High, Medium, Low, Nit. Every finding needs a precise file and diff line, a concrete failure mode, the conditions that trigger it, and the simplest viable fix. Apply [the severity rubric](rules/severity.md) by user impact; do not lower severity merely because confidence is weak. Suppress the finding instead until it is verified. Avoid praise, style-only noise, vague suggestions, speculative warnings, and test-coverage complaints without a concrete uncovered failure mode.

For a GitHub PR, batch confirmed inline findings into one review following [rules/github-comments.md](rules/github-comments.md). A clean review updates Barbarian only and posts nothing to GitHub. Do not post anything for a read-only local review.

After a tracked PR review, report the result to Barbarian:

```bash
printf '%s\n' '{"repository":"owner/repo","number":123,"headSha":"abc...","discussionWatermark":"<value captured in review context>","findings":2,"summary":"two blocking correctness issues"}' \
  | node scripts/report-result.mjs
```

If Barbarian is offline, finish the review and say the durable status update could not be recorded; do not treat that as a review failure.
When Barbarian launched the review automatically, do not call this integration; the dispatcher records the result from `BARBARIAN_RESULT`.

## Output

```text
## CB1 Review: <scope> — <N> findings

Intent: <goal, linked ticket, and whether the change meets it>
Tests: <commands and result, or why not run>

1. <title> — <severity>
   <path>:<line>
   Problem: <specific failure>
   Fix: <specific simpler correction>
```

When there are no findings, say what was checked, what tests ran, and any remaining coverage gap. A clean review is a valid result.
