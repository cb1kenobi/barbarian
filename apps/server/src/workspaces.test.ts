import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { cleanupCompletedWorkspaces } from './workspaces.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const config = {
  version: 1,
  server: { bindAddress: '127.0.0.1', port: 4142, trustedHosts: [] },
  desktop: { launchAtLogin: false, globalShortcut: '' },
  profile: { name: 'Developer', reviewName: '', timezone: 'UTC', githubLogin: '' },
  appearance: { theme: 'dark', fontSize: 'normal', weapon: 'double-axe' },
  monitor: { intervalMinutes: 20, runOnStartup: false, includeDraftPullRequests: false },
  repositories: [],
  review: { requestedReviewer: '', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    codeReview: {}, chat: { provider: 'codex', model: '', effort: '' }, autoReview: false,
    maxConcurrent: 1, maxAutomaticAttempts: 1, retryBaseMinutes: 1,
    maxRunsPerPullRequestPerHour: 1, providers: {},
  },
  statusUpdate: { enabled: false, workdays: [], daysOff: [] },
} satisfies BarbarianConfig;

describe('workspace cleanup', () => {
  it('clears a migrated pointer outside the new cache root without aborting the sweep', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-workspace-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const now = new Date().toISOString();
    database.connection.prepare(`
      INSERT INTO review_queue(
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, first_seen_at, updated_at, last_seen_at, workspace_path
      ) VALUES ('github:Acme/storage#1', 'Acme/storage', 1, 'Closed', 'https://example.test/1',
        'author', 'abcdef1', 'feature', 'main', 'closed', ?, ?, ?, '/legacy/repo/.barbarian/workspaces/pulls/pr1')
    `).run(now, now, now);

    await expect(cleanupCompletedWorkspaces(database, config)).resolves.toBe(1);
    expect(database.connection.prepare('SELECT workspace_path FROM review_queue').get())
      .toEqual({ workspace_path: null });
    database.close();
  });
});
