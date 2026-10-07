import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { countFindingSeverities, findingSeverity, reviewCardMetadata } from './review-card-metadata.js';
import { storedReviewRounds } from './review-rounds.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('findingSeverity', () => {
  it('recognizes the review formats already stored by Barbarian and GitHub agents', () => {
    expect(findingSeverity('**High: corrupts shared state**')).toBe('high');
    expect(findingSeverity('Severity: blocker. This can lose writes.')).toBe('high');
    expect(findingSeverity('![medium](https://example.test/medium-priority.svg)')).toBe('medium');
    expect(findingSeverity('**Low: simplify the cleanup**')).toBe('low');
    expect(findingSeverity('Suggestion (non-blocking): rename this value')).toBe('low');
    expect(findingSeverity('Nit: use the existing helper')).toBe('low');
  });

  it('keeps an explicit high severity when the explanation mentions a non-blocking alternative', () => {
    expect(findingSeverity('**High: data loss**. A non-blocking alternative is available.')).toBe('high');
  });

  it('defaults an unlabelled actionable finding to medium instead of dropping it', () => {
    expect(findingSeverity('This throws when the collection is empty.')).toBe('medium');
  });
});

describe('countFindingSeverities', () => {
  it('returns a complete category total', () => {
    expect(countFindingSeverities([
      { body: 'Blocker: data loss' },
      { body: 'P2: wrong response' },
      { body: 'Nit: naming' },
      { body: 'Suggestion (non-blocking)' },
    ])).toEqual({ high: 1, medium: 1, low: 2 });
  });
});

describe('reviewCardMetadata', () => {
  it('counts clean draft-mode reviews without requiring publication events', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-review-card-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    database.connection.exec(`INSERT INTO review_queue (
      id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
      status, first_seen_at, updated_at, last_seen_at
    ) VALUES ('github:Acme/repo#1', 'Acme/repo', 1, 'Title', 'https://github.com/Acme/repo/pull/1',
      'author', 'head', 'feature', 'main', 'ready_to_merge', '', '', '')`);
    const insert = database.connection.prepare(`
      INSERT INTO agent_runs(review_id, provider, task, status, owner, started_at, finished_at, output)
      VALUES ('github:Acme/repo#1', 'test', ?, ?, ?, '', '', ?)
    `);
    const output = 'BARBARIAN_RESULT: {"findings":0,"verdict":"ready","summary":"Clear.","comments":[]}';
    insert.run('code_review:new_pr', 'complete', 'first', output);
    insert.run('code_review:feedback', 'complete', 'second', output);
    database.connection.exec(`INSERT INTO activity_events(kind, subject_id, summary, payload_json, created_at)
      VALUES ('agent_review_completed', 'github:Acme/repo#1', 'Done',
        '{"publishedReview":false,"savedAsDraft":true,"publishedFindings":0}', '')`);

    expect(reviewCardMetadata(database).get('github:Acme/repo#1')?.review_round_count).toBe(2);
    expect(storedReviewRounds(database, 'github:Acme/repo#1')).toHaveLength(2);

    // Multiple agents/fallback attempts share a round; legacy runs without owners do not.
    insert.run('code_review:new_pr', 'failed', 'first', '');
    insert.run('code_review:manual', 'complete', null, output);
    insert.run('code_review:manual', 'complete', '', output);
    insert.run('code_review:manual', 'failed', 'failed-round', '');
    insert.run('code_review:manual', 'cancelled', 'cancelled-round', '');
    insert.run('code_review:manual', 'running', 'active-round', '');
    insert.run('review_chat', 'complete', 'chat', '');
    expect(reviewCardMetadata(database).get('github:Acme/repo#1')?.review_round_count).toBe(6);
    expect(storedReviewRounds(database, 'github:Acme/repo#1')).toHaveLength(6);
    database.close();
  });
});
