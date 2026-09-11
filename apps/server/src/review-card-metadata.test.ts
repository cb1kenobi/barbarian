import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { countFindingSeverities, findingSeverity, reviewCardMetadata } from './review-card-metadata.js';

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
  it('counts only completed rounds that published a review through Barbarian', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-review-card-test-'));
    directories.push(directory);
    const database = new BarbarianDatabase(path.join(directory, 'test.db'));
    const insert = database.connection.prepare(`
      INSERT INTO activity_events(kind, subject_id, summary, payload_json, created_at)
      VALUES (?, 'github:Acme/repo#1', 'Review event', ?, ?)
    `);
    const now = new Date().toISOString();
    insert.run('review_started', '{}', now);
    insert.run('agent_review_completed', '{"publishedFindings":0}', now);
    insert.run('agent_review_completed', '{"publishedFindings":2}', now);
    insert.run('agent_review_completed', '{"publishedReview":true,"publishedFindings":0}', now);

    expect(reviewCardMetadata(database).get('github:Acme/repo#1')?.review_round_count).toBe(2);
    database.close();
  });
});
