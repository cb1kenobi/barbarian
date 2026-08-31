import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { projectRoot } from './config.js';

export type SqlValue = string | number | bigint | null | Uint8Array;

export class BarbarianDatabase {
  readonly connection: DatabaseSync;

  constructor(filename = path.join(projectRoot, 'data/barbarian.db')) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.connection = new DatabaseSync(filename);
    this.connection.exec('PRAGMA journal_mode = WAL');
    this.connection.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        repository TEXT NOT NULL,
        number INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        simple_summary TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        priority_reasons TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        milestone TEXT,
        duplicate_of TEXT,
        in_progress_pr TEXT,
        fixed_by TEXT,
        remote_state TEXT NOT NULL DEFAULT 'OPEN',
        payload_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(provider, repository, number, kind)
      );

      CREATE TABLE IF NOT EXISTS review_queue (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        simple_summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        author TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        head_ref_name TEXT NOT NULL,
        base_ref_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unreviewed',
        review_decision TEXT,
        findings_count INTEGER NOT NULL DEFAULT 0,
        requested_reviewers TEXT NOT NULL DEFAULT '[]',
        requested_teams TEXT NOT NULL DEFAULT '[]',
        linked_issues TEXT NOT NULL DEFAULT '[]',
        review_skill TEXT NOT NULL DEFAULT 'cb1-code-review',
        last_reviewed_sha TEXT,
        workspace_path TEXT,
        is_draft INTEGER NOT NULL DEFAULT 0,
        remote_state TEXT NOT NULL DEFAULT 'OPEN',
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        merged_at TEXT,
        UNIQUE(repository, number)
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id TEXT NOT NULL REFERENCES review_queue(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id TEXT REFERENCES review_queue(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        task TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        output TEXT NOT NULL DEFAULT '',
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        issues_seen INTEGER NOT NULL DEFAULT 0,
        prs_seen INTEGER NOT NULL DEFAULT 0,
        warnings TEXT NOT NULL DEFAULT '[]',
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        subject_id TEXT,
        remote_key TEXT,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_statuses (
        workday TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        personal_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        copied_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_work_items_queue ON work_items(remote_state, status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_review_queue_active ON review_queue(remote_state, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_review ON chat_messages(review_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events(created_at DESC);
    `);
    const activityColumns = this.connection.prepare('PRAGMA table_info(activity_events)').all() as Array<{ name: string }>;
    if (!activityColumns.some((column) => column.name === 'remote_key')) {
      this.connection.exec('ALTER TABLE activity_events ADD COLUMN remote_key TEXT');
    }
    this.connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_remote_key ON activity_events(remote_key) WHERE remote_key IS NOT NULL');
    this.connection.exec('PRAGMA optimize');
  }

  close(): void {
    this.connection.close();
  }
}
