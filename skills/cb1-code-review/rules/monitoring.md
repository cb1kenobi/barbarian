# Monitoring ownership

Barbarian owns monitoring. Do not start a second sleep loop, cron job, or separate review-state JSON file.

The local server runs one immediate sweep after startup and then at the configured interval (minimum 20 minutes). SQLite records each sweep, the exact reviewed head SHA and trusted-discussion watermark, claims, agent runs, chat, and lifecycle. A machine sleep or shutdown pauses work; server restart resumes from the durable database. New requested PRs, changed heads, and newer feedback from the PR author or repository collaborators become eligible automatically. The authenticated reviewer's own comments and unrelated comments do not trigger runs. Merged and closed PRs leave the active queue and prepared worktrees are cleaned.

Agents invoked by Barbarian perform one bounded review. The dispatcher records their machine-readable result, owns scheduling, limits concurrency, and retries failures with backoff. Agents must not start another monitor or report an automatically dispatched result through the integration endpoint.
