# Monitoring ownership

Barbarian owns monitoring. Do not start a second sleep loop, cron job, or separate review-state JSON file.

The local server runs one immediate sweep after startup and then at the configured interval (minimum 20 minutes). SQLite records each sweep, last-reviewed head SHA, review status, agent runs, chat, and lifecycle. A machine sleep or shutdown pauses work; server restart resumes from the durable database. Open PRs whose SHA changed return to `unreviewed`; merged and closed PRs leave the active queue and prepared worktrees are cleaned.

Agents invoked by Barbarian perform one bounded review and report the result. They do not own scheduling.

