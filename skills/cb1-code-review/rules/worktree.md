# Exact review checkout

Never switch the user's active checkout. For a committed PR, use Barbarian's **Prepare locally** action or its workspace endpoint. Barbarian creates a cached clone and a detached worktree at `pull/<number>/head`, installs with the detected lockfile, runs the build when present, records the path, and cleans it after merge or closure.

If Barbarian is unavailable, create an isolated detached worktree, run the narrowest relevant tests there, and always remove the worktree and temporary ref in a `finally` cleanup. Do not delete the cached clone. Review uncommitted local changes in place because no worktree can represent them.

