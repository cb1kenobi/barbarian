---
name: cb1-code-review
description: Generic, high-signal code review for GitHub pull requests and local branches. Reviews JavaScript, TypeScript, C++, Rust, Markdown, tests, config, and build changes for correctness, security, performance, regressions, and unnecessary complexity. Use for any non-Harper repository when the user asks to review a PR, branch, diff, or code before merge. Uses Barbarian for durable queue state and never creates or updates implementation pull requests.
metadata:
  author: Chris Barber
  tags: code-review, pull-request, security, correctness, barbarian
  version: 2.0.0
---

# CB1 Code Review

Review code without changing it. This skill may read, build, test, and post review comments when the user asked for a PR review. It must not edit the reviewed branch, create commits, push, open a pull request, merge, or approve unless the user separately asks for that action.

For `HarperFast/harper` and `HarperFast/harper-pro`, stop and use `cb1-harper-code-review`. This skill is the generic review layer for every other repository.

## Resolve the target

- PR URL or `owner/repo#number`: run `node scripts/review-context.mjs <target> > /tmp/barbarian-review-context.json` from this skill directory. This script collects intent, linked issues, existing discussion, changed files, and the exact diff through the authenticated GitHub CLI.
- Current PR: resolve it with `gh pr view --json url`, then use the script.
- Local branch: compare the merge base with the remote default branch.
- Uncommitted changes: review in place. Do not attempt to put uncommitted state in a worktree.

Read [rules/review-process.md](rules/review-process.md) and [rules/language-focus.md](rules/language-focus.md) before reviewing. For a PR whose tests need to run, use [rules/worktree.md](rules/worktree.md).

## Review posture

1. Establish the goal and linked-ticket requirements before judging code.
2. Read every changed hunk. For large changes, divide by coherent file groups and reconcile coverage.
3. Trace candidate findings through surrounding code and callers. Report verified problems, not pattern matches.
4. Check correctness, failure cleanup, security boundaries, concurrency, event-loop or hot-path cost, compatibility, tests, docs, and whether the solution is simpler than it needs to be.
5. Check existing GitHub review discussion before posting. Never repeat a problem someone already raised.
6. Run the narrowest relevant tests when practical. State exactly what ran and what could not run.

Default to one pass. If the user asks for deep, thorough, multipass, release, or cross-model review, use the available cross-model review workflow and union only independently verified findings.

## Findings

Order findings by severity: Critical, High, Medium, Low, Nit. Every finding needs a precise file and diff line, a concrete failure mode, and the simplest viable fix. Avoid praise, style-only noise, vague suggestions, and speculative warnings.

For a GitHub PR, batch confirmed inline comments into one review following [rules/github-comments.md](rules/github-comments.md). If the review is clean, post one short clean-review comment with the reviewed head SHA. Do not post anything for a read-only local review.

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
