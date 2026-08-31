# Barbarian

Barbarian is a local-only command center for developer work. It turns assigned issues, requested pull-request reviews, AI review runs, local checkouts, and daily status notes into one durable workflow.

The server binds to `127.0.0.1`, stores state in SQLite, and talks to GitHub through your existing authenticated `gh` CLI. No Barbarian account or hosted service is involved.

## What works

- A priority queue for assigned GitHub issues, with configurable repository/label weights and built-in data-integrity and `rocksdb-js` boosts.
- Safety checks before work enters the actionable queue: duplicate labels/references, near-duplicate titles, linked open PRs, and linked merged fixes.
- A review queue for PRs requesting you or a configured fallback team. Existing tracked reviews stay visible after the request is cleared.
- Durable review states: needs review, agent working, issues found, waiting on feedback, ready, approved, merged, or closed.
- A 20-minute-or-greater background sweep. Head-SHA changes return a reviewed PR to the queue; merge/close removes it from the active queue.
- Persisted PR chat and configurable local AI CLIs (Codex, Claude, Gemini, or another command).
- A safe **Prepare locally** action that clones/fetches, creates a detached worktree, installs from the detected lockfile, and builds when a build script exists.
- Automatic cleanup of prepared worktrees after merge or closure.
- An editable morning status draft and previous-workday counts derived from GitHub contributions plus Barbarian activity.
- A dev-mode Chrome extension for GitHub PR pages and a Cursor/VS Code extension for local repositories.
- A generic `cb1-code-review` skill owned by this repo. Harper-specific review skills remain in `cb1-skills`.
- An adapter contract for Linear, so a local CLI or MCP bridge can feed Linear work into the same queue.

## Architecture

```text
apps/web                 React/Vite dashboard
apps/server              Fastify API, monitor, SQLite, agent/worktree orchestration
apps/chrome-extension    unpacked Manifest V3 GitHub companion
apps/vscode-extension    Cursor/VS Code review companion
skills/cb1-code-review   generic review skill and curated GitHub scripts
scripts                  sync, configuration, skill linking, cleanup, launchd
config                   committed example + ignored machine-local YAML
data                     ignored SQLite database and service logs
```

SQLite is at `data/barbarian.db` and uses WAL mode. Configuration and secrets remain outside git:

- `config/barbarian.yaml` — watched repositories, priorities, monitor, agent commands, days off.
- `.env` — optional API keys and local bind settings.

Both files are created from their committed examples the first time the server or `pnpm configure` runs.

## Requirements

- Node.js 24 or newer (Barbarian uses the built-in `node:sqlite` module).
- pnpm.
- GitHub CLI, authenticated with `gh auth status`.
- Any AI CLIs you enable in `config/barbarian.yaml`.

## Start

```bash
pnpm install
pnpm configure
# Edit config/barbarian.yaml and .env
pnpm dev
```

Open [http://127.0.0.1:4141](http://127.0.0.1:4141) in development.

For a production-style local run:

```bash
pnpm build
pnpm start
```

The built server serves the dashboard at [http://127.0.0.1:4142](http://127.0.0.1:4142).

### Resume after restart or wake (macOS)

After `pnpm build`, install the included user launch agent:

```bash
pnpm service:install
```

It runs at login, stays alive, and writes logs under `data/`. The database is the source of truth, so an overnight shutdown does not lose review SHAs, chat, queue status, or the last sweep. On launch, Barbarian immediately synchronizes and then returns to the configured interval.

## Configure repositories and priority

`config/barbarian.yaml` is deliberately generic. Add every repository Barbarian should watch:

```yaml
profile:
  name: Chris
  timezone: America/Chicago
  githubLogin: cb1kenobi

repositories:
  - name: HarperFast/rocksdb-js
    priority: 100
    watchIssues: true
    watchPullRequests: true
    reviewSkill: cb1-code-review
    labels:
      data-loss: 150
      security: 80

  - name: HarperFast/harper
    priority: 40
    watchIssues: true
    watchPullRequests: true
    reviewSkill: cb1-harper-code-review
    labels:
      regression: 60

review:
  requestedReviewer: cb1kenobi
  fallbackTeams: [Developers, Front End]
```

Priority is additive: repository weight + configured label weights + milestone weight + built-in data-integrity signal + a `rocksdb-js` signal. The dashboard shows the reasons so the ordering is explainable.

The team fallback only applies when no individual reviewer is requested. This avoids pulling every team PR into a personal queue while preserving the “team-only assignment” workflow.

## Monitoring and scripts

The server performs one bounded sync at a time. It does not start an agent for an unchanged PR.

```bash
pnpm sync                                      # one durable sweep
pnpm exec tsx scripts/discover-github.mts      # curated JSON without writing state
pnpm clean:reviews                              # cleanup merged/closed worktrees
```

Agents should use the curated discovery/context scripts instead of assembling ad hoc GitHub queries. The generic review skill includes:

```bash
node skills/cb1-code-review/scripts/review-context.mjs owner/repo#123
```

This returns metadata, linked issues, existing discussion, checks, files, commits, and the exact diff as JSON.

## AI agents

Agent commands are arrays, not shell strings. Barbarian launches them without a shell and sends the prompt on stdin:

```yaml
agents:
  default: codex
  providers:
    codex:
      command: codex
      args: [exec, --skip-git-repo-check, "-"]
    claude:
      command: claude
      args: [-p]
```

Put provider keys in `.env` if the CLI uses them. Barbarian inherits that environment but never returns secrets from its settings API.

The review-agent prompt is intentionally review-only: it forbids branch edits, commits, pushes, and PR creation. Implementation agents should run as a separate deliberate workflow after you accept a plan; they are not launched automatically by issue discovery.

## Linear adapter

Set `linear.enabled: true` and provide a local command. This is suitable for a small wrapper around a Linear CLI, SDK, or MCP exporter:

```yaml
linear:
  enabled: true
  command: [node, /absolute/path/to/export-my-linear-issues.mjs]
```

The command writes a JSON array to stdout:

```json
[
  {
    "identifier": "ENG-123",
    "title": "Fix reconnect behavior",
    "description": "...",
    "url": "https://linear.app/acme/issue/ENG-123/...",
    "updatedAt": "2026-08-31T12:00:00Z",
    "priority": 80,
    "labels": ["customer"],
    "milestone": "September",
    "project": "SDK",
    "duplicateOf": null,
    "inProgressUrl": null,
    "fixedBy": null
  }
]
```

This keeps the core independent of a particular Linear authentication or MCP implementation.

## Chrome extension

1. Start Barbarian.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and choose `apps/chrome-extension`.
5. Open a GitHub pull request tracked by Barbarian.

The `B` button opens the PR’s plain-language status, can ask the configured agent a question, and can capture selected GitHub text into the persisted review room.

## Cursor / VS Code extension

Build and install a local VSIX:

```bash
pnpm --filter barbarian-vscode-extension build
pnpm --filter barbarian-vscode-extension package
```

Install the generated `.vsix` in Cursor or VS Code. Commands:

- **Barbarian: Open Review Context** — match the current git remote/branch to a tracked PR.
- **Barbarian: Send Selection to Review Room** — persist selected local code and a note.
- **Barbarian: Open Dashboard**.

## Skills

Link skills from `skills-internal`, `cb1-skills`, and Barbarian into both agent locations:

```bash
node scripts/link-skills.mjs --dry-run
pnpm link:skills
```

Sources are applied in that order, so Barbarian’s generic `cb1-code-review` wins over an old copy from `cb1-skills`; Harper-specific skills continue to resolve from `cb1-skills`, and current Harper engineering skills resolve from `skills-internal`. Real directories are never overwritten—only existing symlinks are updated.

## Data and safety

- Back up `data/barbarian.db` if you want to retain workflow history.
- Prepared checkouts live under `.barbarian/workspaces` by default and are gitignored.
- Cleanup validates every path is below that configured root and removes worktrees through git.
- The API accepts only localhost, Chrome-extension, and VS Code webview origins and binds to loopback by default.
- Barbarian does not post the daily status to Slack; it saves and copies an editable draft.
- Do not expose port 4142 to another machine. There is intentionally no authentication for this local-only application.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```
