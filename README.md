# <img src="assets/branding/barbarian-axe.png" alt="" width="32" height="32" align="absmiddle"> BARBARIAN

Barbarian is a personal command center for developer work. It turns assigned issues, requested pull-request reviews, AI review runs, local checkouts, and daily status notes into one durable workflow.

The server binds to `127.0.0.1` by default, stores state in SQLite, and talks to GitHub through your existing authenticated `gh` CLI. No Barbarian account or hosted service is involved. It can explicitly bind to `0.0.0.0` for access over a trusted VPN, but Barbarian has no built-in authentication.

## What works

- A priority queue for assigned GitHub issues, with configurable repository/label weights and repository-neutral milestone, severity, and data-integrity signals.
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
apps/desktop             Electron main process and secure renderer bridge
apps/chrome-extension    unpacked Manifest V3 GitHub companion
apps/vscode-extension    Cursor/VS Code review companion
config                   committed configuration example
data                     legacy repo-local state, migrated on first launch
scripts                  sync, configuration, skill linking, cleanup, launchd
skills/cb1-code-review   generic review skill and curated GitHub scripts
```

Runtime state is outside the checkout, so an installed `Barbarian.app` does not depend on the repository:

- `~/Library/Application Support/Barbarian/config/barbarian.yaml` — watched repositories, server address, desktop preferences, priorities, monitor, agent commands, and days off.
- `~/Library/Application Support/Barbarian/data/barbarian.db` — SQLite database in WAL mode.
- `~/Library/Application Support/Barbarian/.env` — optional API keys.
- `~/Library/Caches/Barbarian` — prepared worktrees, logs, and Electron cache data.

The files are created from their committed examples the first time the server, `pnpm configure`, or `pnpm desktop:package` runs. If an older checkout contains `config/barbarian.yaml`, `.env`, and `data/barbarian.db`, Barbarian copies them to Application Support once, without deleting or overwriting the originals. Stop an older running server before that first migration so SQLite can be copied consistently. Legacy `BARBARIAN_HOST` and `BARBARIAN_PORT` values in `.env` are no longer read; set the listener in Settings before restarting.

## Requirements

- Node.js 24 or newer (Barbarian uses the built-in `node:sqlite` module).
- pnpm.
- GitHub CLI, authenticated with `gh auth status`.
- Any AI CLIs you enable in Barbarian Settings.

## Start

```bash
pnpm install
pnpm configure
# Add repositories in Settings and optional keys to the Application Support .env
pnpm dev
```

`pnpm configure` creates the local files and runs an interactive setup wizard. It asks for your name, GitHub username, whether Barbarian should sync when it starts, which detected AI CLI should be the default, and whether to prepare the editor and Chrome extensions. The wizard looks for `codex`, `claude`, `gemini`, and `cursor-agent` on your `PATH`; it only offers installed CLIs and preserves existing answers when rerun. The GitHub username is also used as the requested reviewer when building your review queue.

If requested, the wizard builds and packages the Cursor/VS Code extension. It installs the resulting VSIX automatically into every detected `cursor` or `code` CLI; if neither command is available, it prints the VSIX path for **Extensions: Install from VSIX...**. Chrome does not allow a local unpacked extension to install itself, so the wizard validates the extension and prints its absolute directory plus the `chrome://extensions` steps.

The startup question controls the initial sync after the server launches. To launch the standalone Node server automatically when you log into macOS, build it and install the separate LaunchAgent described below.

Open [http://127.0.0.1:4141](http://127.0.0.1:4141) in development.

For a production-style local run:

```bash
pnpm build
pnpm start
```

The built server serves the dashboard at [http://127.0.0.1:4142](http://127.0.0.1:4142).

### Electron app (macOS)

The Electron app and standalone Node server are two front ends for the same code and data; adopting Electron is not a one-way migration. For development, run:

```bash
pnpm install
pnpm desktop:dev
```

To create an unsigned, self-contained macOS application:

```bash
pnpm desktop:package
```

The result is `out/mac-arm64/Barbarian.app` on Apple silicon (or the corresponding architecture directory). Copy it to `/Applications` if desired. This local build is intentionally not signed or notarized. After verifying the app sees your data, the source checkout can be deleted; persistent data and the stable unpacked Chrome extension copy live under Application Support.

The app starts the server as a managed child process, opens the dashboard, and stops that child when the app quits. Closing the window hides it; use the app menu or the configurable global shortcut (default <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Space</kbd>) to bring it back. **Launch at Login** uses the normal macOS login-item setting and starts the app hidden. If the configured server is already running as a standalone Node process, the app attaches to it instead of starting a second copy; in that case, restart that Node process yourself after changing its listener settings.

The **Extensions** app menu can install the bundled VS Code or Cursor VSIX. It also prepares a stable Chrome extension directory and reveals it for Chrome's **Load unpacked** flow.

Server address changes are made in Settings and stored in YAML. They do not affect a running listener until restart. The Electron app offers to restart the child server immediately; with `pnpm start`, restart the Node process. Use `127.0.0.1` unless remote access is required. Choosing `0.0.0.0` exposes the unauthenticated API on every interface, so restrict it with a trusted VPN and host firewall, and list every VPN hostname or IP address clients will use under **Trusted remote hosts**. Requests with any other Host value are rejected.

### Resume after restart or wake (macOS)

After `pnpm build`, install the included user launch agent:

```bash
pnpm service:install
```

It runs at login, stays alive, and writes logs under `~/Library/Caches/Barbarian`. The database is the source of truth, so an overnight shutdown does not lose review SHAs, chat, queue status, or the last sweep. On launch, Barbarian immediately synchronizes and then returns to the configured interval.

The service is installed as the macOS LaunchAgent `io.barbarian.local` with `KeepAlive` enabled. If you kill the server process directly, `launchd` starts it again. Stop the LaunchAgent before running Barbarian manually:

```bash
launchctl bootout gui/$(id -u)/io.barbarian.local
```

It remains installed and will load again the next time you log in. To start it again without logging out:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.barbarian.local.plist
```

To restart the running service after rebuilding it:

```bash
launchctl kickstart -k gui/$(id -u)/io.barbarian.local
```

To uninstall it completely, unload it and remove its property list:

```bash
launchctl bootout gui/$(id -u)/io.barbarian.local
rm ~/Library/LaunchAgents/io.barbarian.local.plist
```

Service output is written to `~/Library/Caches/Barbarian/barbarian.log` and errors to `~/Library/Caches/Barbarian/barbarian-error.log`.

## Configure repositories and priority

The generated `barbarian.yaml` is deliberately generic. Add every repository Barbarian should watch:

```yaml
profile:
  name: Developer
  reviewName: ""
  timezone: America/Chicago
  githubLogin: your-login

repositories:
  - name: your-org/important-backend
    priority: 100
    watchIssues: true
    watchPullRequests: true
    reviewSkill: cb1-code-review
    labels:
      data-loss: 150
      security: 80

  - name: your-org/frontend
    priority: 40
    watchIssues: true
    watchPullRequests: true
    reviewSkill: cb1-code-review
    labels:
      regression: 60

review:
  requestedReviewer: your-login
  fallbackTeams: [Developers, Front End]
```

`reviewName` is optional attribution for AI review comments. Set it to a name such as `CB1` to publish “CB1 reviewed `<sha>`”; leave it blank to publish “Reviewed `<sha>`” without naming the reviewer.

Priority is additive: configured repository weight + configured label weights + milestone weight + standard severity-label weight + a repository-neutral data-integrity signal. Repository names never affect the score. The dashboard shows the reasons so the ordering is explainable.

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
  codeReview:
    - id: codex-default
      provider: codex
      model: ""
      effort: ""
      priority: 100
    - id: claude-second-account
      provider: claude-secondary
      model: opus
      effort: high
      priority: 80
  reviewRouting: round_robin # random, round_robin, or priority
  usageHeadroomPercent: 20
  chat:
    provider: claude
    model: ""
    effort: ""
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
    claude-secondary:
      command: claude
      args: [-p]
      env:
        CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_SECONDARY_OAUTH_TOKEN}
    cursor:
      command: cursor-agent
      args: [-p, --mode, ask, --output-format, text]
```

Add zero or more code review rows in Settings, with an independent provider, model, effort, and priority. One available row handles each review. Random and round-robin routing spread work across the pool; priority routing chooses the highest number first. Before every selection and failover, providers with known usage above `100 - usageHeadroomPercent` are removed. Codex and token-authenticated Claude providers have built-in usage checks. Other CLIs remain eligible when their usage is unknown; provider definitions can supply `usageCommand: [command, arg]`, whose stdout must be a percentage or `{"usedPercent": 42}`.

If a review agent fails, Barbarian refreshes the current configuration and usage data, then tries the next eligible row. A forced choice from the Agent review dropdown first selects that exact row and limits failover to rows from the same provider family with the same model and effort. This lets one Claude account fail over to another without silently changing models. Agent chat remains a separate single provider/model/effort selection.

For multiple Claude subscription accounts, run `claude setup-token` while signed in to each account, put each token under a unique name in Barbarian’s private `.env`, and define one named provider instance per token as shown above. `${CLAUDE_SECONDARY_OAUTH_TOKEN}` is resolved from `.env` only when that provider launches; the token is not returned by the settings API or stored in agent-run commands. `CLAUDE_CONFIG_DIR` can also isolate file-backed Claude profiles on Linux and Windows, but macOS stores interactive credentials in Keychain, so per-provider OAuth tokens are the reliable unattended option there.

Provider API keys are optional because Barbarian launches local CLI programs. A CLI authenticated through its own login flow—such as `codex login` using ChatGPT—does not need an API key in `.env`. Put a provider key or OAuth token there only when that provider instance is configured to use one. Barbarian inherits the environment but never returns secrets from its settings API.

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
4. Click **Load unpacked** and choose `apps/chrome-extension`, or the stable directory revealed by the Electron app's **Extensions → Prepare Chrome Extension…** menu item.
5. Open a GitHub pull request tracked by Barbarian.

Open the extension's **Details → Extension options** page to set the Barbarian server URL and test the connection. The default is `http://127.0.0.1:4142`; a client on another machine should use the server Mac's VPN hostname or VPN address. Chrome asks for permission to reach a non-default origin when you save it.

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

### One-command VS Code install

Make sure the VS Code `code` command is available on your `PATH`, then run this from the repository root:

```bash
pnpm vscode:install
```

This command builds the extension, creates the versioned `.vsix` package in `apps/vscode-extension`, and installs it in VS Code with `--force`. Run **Developer: Reload Window** in VS Code after it finishes. The package filename is derived from the extension's `package.json`, so the command continues to work when the extension version changes.

This command targets VS Code. To install in Cursor, build the VSIX and use the Cursor command or editor UI described below.

### Manual build and installation

To build a local VSIX without installing it:

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
cursor --install-extension apps/vscode-extension/barbarian-vscode-extension-0.3.0.vsix --force

# VS Code
code --install-extension apps/vscode-extension/barbarian-vscode-extension-0.3.0.vsix --force
```

After changing the extension, rebuild, package, reinstall with `--force`, and reload the editor window. If the `cursor` or `code` command is unavailable, use the editor UI method above.

Open the Barbarian icon in the Activity Bar to use the dockable **Branch Review** view. It follows the checked-out branch in the active workspace and keeps working before a pull request exists. The panel provides:

- **Agent review** for either the local branch diff or its tracked pull request.
- A pull-request summary when `gh` can associate the branch with a PR.
- Findings that open directly at the local file and line.
- A shared review room. Once the branch is attached to a tracked PR, its conversation is the same one shown in the dashboard and Chrome extension.
- Inline editor selection context in the question composer, without a separate send-selection command.

Use **Barbarian: Show Branch Review** from the Command Palette to focus the view. Use **Barbarian: Configure Server Connection** (or the `barbarian.serverUrl` setting) when Barbarian is not running at the default local address. VS Code can move the Barbarian view container between the primary and secondary sidebars.

## Skills

Link skills from `skills-internal`, `cb1-skills`, and Barbarian into both agent locations:

```bash
node scripts/link-skills.mjs --dry-run
pnpm link:skills
```

Sources are applied in that order, so Barbarian’s generic `cb1-code-review` wins over an old copy from `cb1-skills`; Harper-specific skills continue to resolve from `cb1-skills`, and current Harper engineering skills resolve from `skills-internal`. Real directories are never overwritten—only existing symlinks are updated.

## Data and safety

- Back up `~/Library/Application Support/Barbarian` if you want to retain configuration, secrets, and workflow history. A copied legacy `config` and `data` directory remains a useful migration backup.
- Prepared checkouts live under `~/Library/Caches/Barbarian/.barbarian/workspaces` by default.
- Cleanup validates every path is below that configured root and removes worktrees through git.
- VS Code review-room agents run in the open Git checkout so they can carry out an explicit editing request. Barbarian verifies that the checkout's `origin` matches the repository reported by the extension before starting the agent.
- Active agent prompts are retained only while the agent is running and are available only to the dashboard's own origin; completed, failed, interrupted, and cancelled runs clear the prompt.
- Browser API access accepts the dashboard's exact origin, Chrome extensions, and VS Code webviews. The server binds to loopback by default.
- Barbarian does not post the daily status to Slack; it saves and copies an editable draft.
- Binding to `0.0.0.0` is an explicit opt-in for trusted VPN access. There is intentionally no authentication, so do not expose the port directly to an untrusted LAN or the public internet.

## Verify

```bash
pnpm typecheck
pnpm test
pnpm build
```
