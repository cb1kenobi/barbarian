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
    this.connection.exec('PRAGMA busy_timeout = 2000');
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
        assignees TEXT NOT NULL DEFAULT '[]',
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
        plain_summary TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL,
        author TEXT NOT NULL,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        head_sha TEXT NOT NULL,
        head_ref_name TEXT NOT NULL,
        base_ref_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unreviewed',
        review_decision TEXT,
        viewer_review_state TEXT,
        viewer_review_sha TEXT,
        other_approvals INTEGER NOT NULL DEFAULT 0,
        findings_count INTEGER NOT NULL DEFAULT 0,
        requested_reviewers TEXT NOT NULL DEFAULT '[]',
        requested_teams TEXT NOT NULL DEFAULT '[]',
        linked_issues TEXT NOT NULL DEFAULT '[]',
        review_skill TEXT NOT NULL DEFAULT 'cb1-code-review',
        last_reviewed_sha TEXT,
        discussion_watermark TEXT NOT NULL DEFAULT '',
        last_reviewed_watermark TEXT,
        claim_owner TEXT,
        claimed_at TEXT,
        manual_requested_at TEXT,
        manual_provider TEXT,
        review_paused INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        attempt_head_sha TEXT,
        attempt_watermark TEXT,
        retry_after TEXT,
        last_agent_error TEXT,
        workspace_path TEXT,
        is_draft INTEGER NOT NULL DEFAULT 0,
        remote_state TEXT NOT NULL DEFAULT 'OPEN',
        remote_created_at TEXT,
        remote_updated_at TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        merged_at TEXT,
        UNIQUE(repository, number)
      );

      CREATE TABLE IF NOT EXISTS review_findings (
        id TEXT PRIMARY KEY,
        review_id TEXT NOT NULL REFERENCES review_queue(id) ON DELETE CASCADE,
        remote_id INTEGER NOT NULL,
        author TEXT NOT NULL,
        body TEXT NOT NULL,
        summary TEXT NOT NULL,
        url TEXT NOT NULL,
        path TEXT,
        line INTEGER,
        resolved INTEGER NOT NULL DEFAULT 0,
        outdated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(review_id, remote_id)
      );

      CREATE TABLE IF NOT EXISTS local_branches (
        id TEXT PRIMARY KEY,
        repository TEXT NOT NULL,
        remote_url TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        base_ref TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        worktree_state TEXT NOT NULL DEFAULT '',
        is_dirty INTEGER NOT NULL DEFAULT 0,
        workspace_path TEXT NOT NULL,
        review_id TEXT REFERENCES review_queue(id) ON DELETE SET NULL,
        pull_request_repository TEXT,
        pull_request_number INTEGER,
        pull_request_title TEXT,
        pull_request_summary TEXT,
        pull_request_url TEXT,
        pull_request_author TEXT,
        status TEXT NOT NULL DEFAULT 'unreviewed',
        summary TEXT NOT NULL DEFAULT '',
        findings_count INTEGER NOT NULL DEFAULT 0,
        last_reviewed_sha TEXT,
        last_reviewed_worktree_state TEXT,
        last_agent_error TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(repository, branch_name)
      );

      CREATE TABLE IF NOT EXISTS local_branch_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_id TEXT NOT NULL REFERENCES local_branches(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        side TEXT NOT NULL,
        summary TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(branch_id, ordinal)
      );

      CREATE TABLE IF NOT EXISTS local_branch_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        branch_id TEXT NOT NULL REFERENCES local_branches(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
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
        error TEXT,
        owner TEXT,
        reviewed_head_sha TEXT,
        reviewed_watermark TEXT
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
      CREATE INDEX IF NOT EXISTS idx_review_findings_review ON review_findings(review_id, resolved, outdated);
      CREATE INDEX IF NOT EXISTS idx_local_branches_review ON local_branches(review_id);
      CREATE INDEX IF NOT EXISTS idx_local_branch_findings_branch ON local_branch_findings(branch_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_local_branch_messages_branch ON local_branch_messages(branch_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_chat_messages_review ON chat_messages(review_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_events(created_at DESC);
    `);
    const activityColumns = this.connection.prepare('PRAGMA table_info(activity_events)').all() as Array<{ name: string }>;
    if (!activityColumns.some((column) => column.name === 'remote_key')) {
      this.connection.exec('ALTER TABLE activity_events ADD COLUMN remote_key TEXT');
    }
    const initialReviewColumns = this.connection.prepare('PRAGMA table_info(review_queue)').all() as Array<{ name: string }>;
    if (!initialReviewColumns.some((column) => column.name === 'plain_summary')) {
      this.connection.exec("ALTER TABLE review_queue ADD COLUMN plain_summary TEXT NOT NULL DEFAULT ''");
    }
    const workItemColumns = new Set((this.connection.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!workItemColumns.has('assignees')) this.connection.exec("ALTER TABLE work_items ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]'");
    const reviewColumns = new Set((this.connection.prepare('PRAGMA table_info(review_queue)').all() as Array<{ name: string }>).map((column) => column.name));
    const reviewAdditions: Array<[string, string]> = [
      ['discussion_watermark', "TEXT NOT NULL DEFAULT ''"],
      ['last_reviewed_watermark', 'TEXT'],
      ['claim_owner', 'TEXT'],
      ['claimed_at', 'TEXT'],
      ['manual_requested_at', 'TEXT'],
      ['manual_provider', 'TEXT'],
      ['review_paused', 'INTEGER NOT NULL DEFAULT 0'],
      ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['attempt_head_sha', 'TEXT'],
      ['attempt_watermark', 'TEXT'],
      ['retry_after', 'TEXT'],
      ['last_agent_error', 'TEXT'],
      ['viewer_review_state', 'TEXT'],
      ['viewer_review_sha', 'TEXT'],
      ['other_approvals', 'INTEGER NOT NULL DEFAULT 0'],
      ['remote_created_at', 'TEXT'],
      ['remote_updated_at', 'TEXT'],
      ['additions', 'INTEGER NOT NULL DEFAULT 0'],
      ['deletions', 'INTEGER NOT NULL DEFAULT 0'],
    ];
    for (const [name, definition] of reviewAdditions) {
      if (!reviewColumns.has(name)) this.connection.exec(`ALTER TABLE review_queue ADD COLUMN ${name} ${definition}`);
    }
    this.connection.exec('UPDATE review_queue SET remote_updated_at=updated_at WHERE remote_updated_at IS NULL');
    const runColumns = new Set((this.connection.prepare('PRAGMA table_info(agent_runs)').all() as Array<{ name: string }>).map((column) => column.name));
    const runAdditions: Array<[string, string]> = [
      ['owner', 'TEXT'], ['reviewed_head_sha', 'TEXT'], ['reviewed_watermark', 'TEXT'],
    ];
    for (const [name, definition] of runAdditions) {
      if (!runColumns.has(name)) this.connection.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${definition}`);
    }
    if (!runColumns.has('branch_id')) this.connection.exec('ALTER TABLE agent_runs ADD COLUMN branch_id TEXT REFERENCES local_branches(id) ON DELETE SET NULL');
    const branchColumns = new Set((this.connection.prepare('PRAGMA table_info(local_branches)').all() as Array<{ name: string }>).map((column) => column.name));
    const branchAdditions: Array<[string, string]> = [
      ['is_dirty', 'INTEGER NOT NULL DEFAULT 0'],
      ['pull_request_repository', 'TEXT'], ['pull_request_number', 'INTEGER'],
      ['pull_request_title', 'TEXT'], ['pull_request_summary', 'TEXT'],
      ['pull_request_url', 'TEXT'], ['pull_request_author', 'TEXT'],
    ];
    for (const [name, definition] of branchAdditions) {
      if (!branchColumns.has(name)) this.connection.exec(`ALTER TABLE local_branches ADD COLUMN ${name} ${definition}`);
    }
    this.connection.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_remote_key ON activity_events(remote_key) WHERE remote_key IS NOT NULL');
    this.connection.exec('PRAGMA optimize');
  }

  close(): void {
    this.connection.close();
  }
}
