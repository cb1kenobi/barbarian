import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { storedReviewRounds } from './review-rounds.js';

let database: BarbarianDatabase;
beforeEach(() => {
  database = new BarbarianDatabase(':memory:');
  database.connection.exec(`INSERT INTO review_queue (
    id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
    status, first_seen_at, updated_at, last_seen_at
  ) VALUES ('review', 'Acme/repo', 1, 'Title', 'https://github.com/Acme/repo/pull/1', 'author',
    'new-head', 'feature', 'main', 'ready_to_merge', '', '', '')`);
});
afterEach(() => database.close());

function addRun(owner: string | null, head: string, comments: unknown[], status = 'complete') {
  const result = { findings: comments.length, verdict: comments.length ? 'issues' : 'ready', summary: comments.length ? 'A bug.' : 'Clear.', comments };
  database.connection.prepare(`INSERT INTO agent_runs(
    review_id, provider, task, status, started_at, finished_at, owner, reviewed_head_sha, output, error
  ) VALUES ('review', 'test', 'code_review:manual', ?, '2026-10-07T12:00:00Z', '2026-10-07T12:01:00Z', ?, ?, ?, ?)`)
    .run(status, owner, head, `BARBARIAN_RESULT: ${JSON.stringify(result)}`, status === 'failed' ? 'Provider unavailable' : null);
}

describe('review round history', () => {
  it('retains earlier issues and clean rounds without counting history as current issues', () => {
    const comment = { path: 'file.ts', line: 4, side: 'RIGHT', body: '**High: Broken invariant**\nDetails.' };
    addRun('first', 'old-head', [comment, comment]);
    addRun('second', 'new-head', []);
    const rounds = storedReviewRounds(database, 'review');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ findings: 0, summary: 'Clear.', outdated: false, comments: [] });
    expect(rounds[1]).toMatchObject({ findings: 1, summary: 'A bug.', outdated: true, comments: [{ body: comment.body, path: 'file.ts', line: 4 }] });
    expect(rounds[1]?.comments[0]?.url).toMatch(/\/files\/old-head#diff-[a-f0-9]+R4$/);
    expect(database.connection.prepare('SELECT * FROM local_review_findings').all()).toEqual([]);
  });

  it('groups fallback attempts into a single round and retains independent legacy runs', () => {
    addRun('first', 'old-head', [], 'failed');
    addRun('first', 'old-head', []);
    addRun(null, 'new-head', []);
    addRun(null, 'new-head', []);
    expect(storedReviewRounds(database, 'review')).toHaveLength(3);
    expect(storedReviewRounds(database, 'review').every((round) => round.status === 'complete')).toBe(true);
  });

  it('reports GitHub delivery failure alongside the retained result', () => {
    addRun('first', 'new-head', [{ path: 'file.ts', line: 4, side: 'RIGHT', body: 'A bug.' }]);
    database.connection.prepare(`INSERT INTO activity_events(kind, summary, subject_id, payload_json, created_at)
      VALUES ('agent_review_failed', 'failed', 'review', ?, '')`).run(JSON.stringify({ owner: 'first', error: 'GitHub unavailable' }));
    expect(storedReviewRounds(database, 'review')[0]).toMatchObject({ findings: 1, delivery: 'Delivery failed', error: 'GitHub unavailable' });
  });

  it('preserves issues from all successful reviewers in older multi-agent rounds', () => {
    const comment = { path: 'file.ts', line: 4, side: 'RIGHT', body: 'A bug.' };
    addRun('first', 'old-head', [comment]);
    addRun('first', 'old-head', []);
    expect(storedReviewRounds(database, 'review')).toHaveLength(1);
    expect(storedReviewRounds(database, 'review')[0]).toMatchObject({ findings: 1, comments: [{ body: 'A bug.' }] });
  });

  it('handles older completed output without a machine-readable result', () => {
    addRun('first', 'old-head', []);
    database.connection.prepare('UPDATE agent_runs SET output=?').run('Legacy review prose');
    expect(storedReviewRounds(database, 'review')[0]).toMatchObject({ findings: null, comments: [], status: 'complete', summary: 'Legacy review prose' });
  });
});
