# Barbarian

Barbarian is a local-only command center for developer work. It turns assigned issues, requested pull-request reviews, AI review runs, local checkouts, and daily status notes into one durable workflow.

The server binds to `127.0.0.1`, stores state in SQLite, and talks to GitHub through your existing authenticated `gh` CLI. No Barbarian account or hosted service is involved.

## What works

- A priority queue for assigned GitHub issues, with configurable repository/label weights and built-in data-integrity and `rocksdb-js` boosts.
- Safety checks before work enters the actionable queue: duplicate labels/references, near-duplicate titles, linked open PRs, and linked merged fixes.
- A review queue for PRs requesting you or a configured fallback team. Existing tracked reviews stay visible after the request is cleared.
- Durable review states: needs review, agent working, issues found, waiting on feedback, ready, approved, merged, or closed.
- A 20-minute-or-greater background sweep. New review requests, new commits, and trusted author/collaborator feedback automatically enqueue another bounded review; merge/close removes the PR from the active queue.
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

The server performs one bounded sync at a time. After each sweep it derives review eligibility from the current head SHA and trusted-discussion watermark versus the exact inputs covered by the last successful agent run. It does not start an agent for an unchanged PR, its own GitHub comments, or unrelated drive-by comments.

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
  autoReview: true
  maxConcurrent: 2
  maxAutomaticAttempts: 3
  retryBaseMinutes: 5
  maxRunsPerPullRequestPerHour: 3
  providers:
    codex:
      command: codex
      args: [exec, --sandbox, read-only, --skip-git-repo-check, "-"]
    claude:
      command: claude
      args: [-p]
```

Provider API keys are optional because Barbarian launches local CLI programs. A CLI authenticated through its own login flow—such as `codex login` using ChatGPT—does not need an API key in `.env`. Put a provider key there only when that CLI is configured to use one. Barbarian inherits the environment but never returns secrets from its settings API.

Automatic review is off by default for existing installations so an upgrade cannot begin spending agent usage unexpectedly. Set `agents.autoReview: true` to enable it. Barbarian runs agents only while an eligible event is being handled; a healthy idle system can therefore show zero running agents even though monitoring remains active.

The dispatcher atomically claims each PR, limits all review and chat agents to `maxConcurrent`, retries failures with bounded exponential backoff, and checkpoints the head SHA and discussion watermark captured before launch. A commit or trusted reply arriving during a review remains eligible for the next pass. Automatic reviews never clone, install, build, or execute the PR branch.

GitHub authentication stays in the Barbarian server. The server captures the PR metadata, exact diff, and existing discussion, then sends that untrusted JSON bundle to the read-only reviewer without `GH_TOKEN` or `GITHUB_TOKEN`. Barbarian accepts only a strict machine-readable result, verifies that every proposed inline comment points to a line in the captured diff, and publishes the review itself. The agent never needs GitHub credentials.

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

Click Barbarian’s toolbar icon once to open Chrome’s native side panel. Chrome requires this initial user gesture; after opening, the panel remains beside the webpage while you move between Conversation, Commits, Checks, and Files changed. Because it uses Chrome’s panel instead of injecting an overlay into GitHub, it does not cover the PR content. The panel shows the PR’s workflow state, the latest AI assessment, unresolved and resolved review-comment counts, a plain-language problem/solution summary, and links that jump to each AI review comment.

Chrome does not allow an extension to open its native side panel automatically when a PR loads. Pin Barbarian’s toolbar icon and click it when starting a review; once open, Chrome keeps the panel open through PR navigation.

### Choose which side Chrome panels open on

1. Open `chrome://settings/appearance` in Chrome.
2. Find the **Side panel** setting.
3. Choose **Show on left** or **Show on right**.

This is a browser-wide Chrome preference, so it controls Barbarian and every other Chrome side panel. Extensions can read the selected side but cannot change it themselves.

Use **Ask about PR** to discuss the entire pull request. To ask about particular code, select lines on the GitHub page, optionally type a question, and click **Ask about selection**. Both interactions go through the local Barbarian server. The recent conversation appears in the sidebar, and the complete chat history remains saved in the review room.

Use **▶ Agent review** to start the configured AI review workflow for the active PR. While it is running, the button becomes **■ Stop agent review**. Stopping cancels every in-flight agent process associated with that PR, clears queued manual review work, and pauses automatic review for that version. Starting it again resumes review; new commits or feedback also clear the pause. Use **Test locally** to ask the Barbarian server to clone or update the repository, create a detached PR worktree, install dependencies, and run its build script. The panel reports the prepared workspace path when it finishes.

GitHub findings and resolved states update during Barbarian’s normal sync. While a PR page is open, the native panel rereads Barbarian’s durable state every 30 seconds so agent results and sync changes appear without reloading GitHub.
After changing extension source, click **Reload** for Barbarian on `chrome://extensions` and refresh the GitHub tab.

## Cursor / VS Code extension

Build and install a local VSIX:

```bash
pnpm --filter barbarian-vscode-extension build
pnpm --filter barbarian-vscode-extension package
```

This creates a versioned `.vsix` in `apps/vscode-extension` (the version in the filename comes from `package.json`).

Install it from the editor UI:

1. Open Cursor or VS Code.
2. Open the Command Palette with <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on macOS or <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> on Windows/Linux.
3. Run **Extensions: Install from VSIX...**.
4. Select the generated file in `apps/vscode-extension`.
5. Run **Developer: Reload Window** when prompted.

Or install it from this repository in a terminal:

```bash
# Cursor
cursor --install-extension apps/vscode-extension/barbarian-vscode-extension-0.2.2.vsix --force

# VS Code
code --install-extension apps/vscode-extension/barbarian-vscode-extension-0.2.2.vsix --force
```

After changing the extension, rebuild, package, reinstall with `--force`, and reload the editor window. If the `cursor` or `code` command is unavailable, use the editor UI method above.

Open the Barbarian icon in the Activity Bar to use the dockable **Branch Review** view. It follows the checked-out branch in the active workspace and keeps working before a pull request exists. The panel provides:

- **Agent review** for either the local branch diff or its tracked pull request.
- A pull-request summary when `gh` can associate the branch with a PR.
- Findings that open directly at the local file and line.
- A shared review room. Once the branch is attached to a tracked PR, its conversation is the same one shown in the dashboard and Chrome extension.
- Inline editor selection context in the question composer, without a separate send-selection command.

Use **Barbarian: Show Branch Review** from the Command Palette to focus the view. VS Code can move the Barbarian view container between the primary and secondary sidebars.

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
