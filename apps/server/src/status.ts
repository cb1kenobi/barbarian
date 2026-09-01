import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';

function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function previousWorkday(now: Date, config: BarbarianConfig): string {
  const candidate = new Date(now);
  const allowed = new Set(config.statusUpdate.workdays.map((day) => day.toLowerCase()));
  for (let attempts = 0; attempts < 14; attempts += 1) {
    candidate.setDate(candidate.getDate() - 1);
    const date = localDate(candidate, config.profile.timezone);
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: config.profile.timezone, weekday: 'long' }).format(candidate).toLowerCase();
    if (allowed.has(weekday) && !config.statusUpdate.daysOff.includes(date)) return date;
  }
  return localDate(now, config.profile.timezone);
}

export function buildStatusDraft(database: BarbarianDatabase, config: BarbarianConfig, now = new Date()): {
  workday: string;
  previousWorkday: string;
  lines: string[];
  stats: Record<string, number>;
} {
  const workday = localDate(now, config.profile.timezone);
  const previous = previousWorkday(now, config);
  const active = database.connection.prepare(`
    SELECT repository, title FROM work_items
    WHERE remote_state='OPEN' AND status IN ('queued','in_progress') ORDER BY status='in_progress' DESC, priority DESC LIMIT 4
  `).all() as Array<{ repository: string; title: string }>;
  const reviews = database.connection.prepare(`
    SELECT repository, number, title FROM review_queue
    WHERE remote_state='OPEN' AND status IN ('unreviewed','agent_working','issues_found','awaiting_feedback')
    ORDER BY updated_at DESC LIMIT 3
  `).all() as Array<{ repository: string; number: number; title: string }>;
  const lines = [
    ...active.map((item) => `* ${item.repository.split('/').at(-1)}: ${item.title}`),
    ...reviews.map((pr) => `* ${pr.repository.split('/').at(-1)}: Reviewing #${pr.number}: ${pr.title}`),
  ];
  const recent = database.connection.prepare(`
    SELECT kind, created_at FROM activity_events ORDER BY created_at DESC LIMIT 2000
  `).all() as Array<{ kind: string; created_at: string }>;
  const stats: Record<string, number> = {};
  for (const event of recent) {
    if (localDate(new Date(event.created_at), config.profile.timezone) !== previous) continue;
    stats[event.kind] = (stats[event.kind] || 0) + 1;
  }
  return {
    workday,
    previousWorkday: previous,
    lines,
    stats,
  };
}
