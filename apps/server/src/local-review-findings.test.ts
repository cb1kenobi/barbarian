import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BarbarianDatabase } from './database.js';
import { replaceLocalReviewFindings, localReviewFindings } from './local-review-findings.js';
import { fetchPullRequestReviewContext, type GithubPullRequestReviewContext } from './github.js';
import { refreshReviewContext, storedReviewFindings, buildReviewAssessment } from './review-context.js';
import { reviewCardMetadata } from './review-card-metadata.js';

vi.mock('./github.js', async (original) => ({
  ...await original<typeof import('./github.js')>(), fetchPullRequestReviewContext: vi.fn(),
}));
let database: BarbarianDatabase;
const remote: GithubPullRequestReviewContext = {
  state: 'OPEN', mergedAt: null, reviewDecision: null, headSha: 'head', additions: 1, deletions: 1,
  commitCount: 1, viewerReviewState: null, viewerReviewSha: null, otherApprovals: 0,
  discussionWatermark: '', findings: [], pendingReview: null,
};
const finding = { path: 'src/file.ts', line: 4, side: 'RIGHT' as const, body: '**High: Lost update**\nConcurrent writes lose data.' };
beforeEach(() => {
  database = new BarbarianDatabase(':memory:');
  database.connection.exec(`INSERT INTO review_queue (
    id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
    status, last_reviewed_sha, last_reviewed_watermark, first_seen_at, updated_at, last_seen_at
  ) VALUES ('review', 'Acme/repo', 1, 'Title', 'https://github.com/Acme/repo/pull/1', 'author',
    'head', 'feature', 'main', 'issues_found', 'head', '', '', '', '')`);
  vi.mocked(fetchPullRequestReviewContext).mockResolvedValue(structuredClone(remote));
});
afterEach(() => { database.close(); vi.clearAllMocks(); });

describe('local PR findings', () => {
  it('survives repeated GitHub refreshes without manufacturing remote comment IDs or feedback', async () => {
    replaceLocalReviewFindings(database, 'review', 'head', [finding], 'reviewer', '2026-10-07T12:00:00Z');
    await refreshReviewContext(database, 'review');
    await refreshReviewContext(database, 'review');
    expect(storedReviewFindings(database, 'review')).toMatchObject([{
      source: 'local', remote_id: null, body: finding.body, summary: expect.stringContaining('High: Lost update'), outdated: false,
    }]);
    expect(database.connection.prepare('SELECT status, findings_count FROM review_queue').get())
      .toEqual({ status: 'issues_found', findings_count: 1 });
    expect(database.connection.prepare('SELECT * FROM review_findings').all()).toEqual([]);
    expect(reviewCardMetadata(database).get('review')?.issue_counts).toEqual({ high: 1, medium: 0, low: 0 });
  });

  it('marks findings from previous commits outdated and removes them from active counts', async () => {
    replaceLocalReviewFindings(database, 'review', 'head', [finding], 'reviewer', '2026-10-07T12:00:00Z');
    vi.mocked(fetchPullRequestReviewContext).mockResolvedValue({ ...remote, headSha: 'new-head' });
    await refreshReviewContext(database, 'review');
    expect(localReviewFindings(database, 'review')[0]?.outdated).toBe(true);
    expect(database.connection.prepare('SELECT status, findings_count FROM review_queue').get())
      .toEqual({ status: 'unreviewed', findings_count: 0 });
    expect(reviewCardMetadata(database).get('review')?.issue_counts.high || 0).toBe(0);
  });

  it('replaces earlier local findings and clears them after a clean review', async () => {
    replaceLocalReviewFindings(database, 'review', 'head', [finding], 'reviewer', '');
    replaceLocalReviewFindings(database, 'review', 'head', [finding], 'reviewer', '');
    expect(localReviewFindings(database, 'review')).toHaveLength(1);
    replaceLocalReviewFindings(database, 'review', 'head', [], 'reviewer', '');
    await refreshReviewContext(database, 'review');
    expect(storedReviewFindings(database, 'review')).toEqual([]);
    expect(database.connection.prepare('SELECT status, findings_count FROM review_queue').get())
      .toEqual({ status: 'ready_to_merge', findings_count: 0 });
  });

  it('combines existing GitHub findings with local ones while retaining remote feedback metadata', async () => {
    replaceLocalReviewFindings(database, 'review', 'head', [finding], 'reviewer', '');
    vi.mocked(fetchPullRequestReviewContext).mockResolvedValue({ ...remote, findings: [{
      remoteId: 10, author: 'reviewer', body: 'Remote issue', summary: 'Remote issue', url: 'https://github.com/comment/10',
      path: 'other.ts', line: 1, trustedForFeedback: true, resolved: false, outdated: false, createdAt: '', updatedAt: '',
    }] });
    await refreshReviewContext(database, 'review');
    const findings = storedReviewFindings(database, 'review');
    const row = database.connection.prepare('SELECT * FROM review_queue').get()!;
    expect(findings).toHaveLength(2);
    expect(buildReviewAssessment(row as unknown as Parameters<typeof buildReviewAssessment>[0], findings).counts.open).toBe(2);
    expect(database.connection.prepare('SELECT remote_id, trusted_for_feedback FROM review_findings').all())
      .toEqual([{ remote_id: 10, trusted_for_feedback: 1 }]);
  });

  it('counts local reviews as completed review rounds', () => {
    database.connection.exec(`INSERT INTO activity_events(kind, summary, subject_id, payload_json, created_at)
      VALUES ('agent_review_completed', 'done', 'review', '{"savedLocally":true,"publishedReview":false}', '')`);
    expect(reviewCardMetadata(database).get('review')?.review_round_count).toBe(1);
  });
});
