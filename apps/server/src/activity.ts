import type { BarbarianDatabase } from './database.js';

export function recordActivity(
  database: BarbarianDatabase,
  kind: string,
  summary: string,
  subjectId: string | null = null,
  payload: unknown = {},
  remoteKey: string | null = null,
): void {
  database.connection.prepare(`
    INSERT OR IGNORE INTO activity_events(kind, subject_id, remote_key, summary, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(kind, subjectId, remoteKey, summary, JSON.stringify(payload), new Date().toISOString());
}
