import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPullRequestReviewContext, postPullRequestReview } from './github.js';
import { runProcess } from './process.js';
import { BarbarianDatabase } from './database.js';
import { refreshReviewContext } from './review-context.js';
import { displayReviewStatus } from './review-state.js';
import { reviewTrigger } from './dispatcher.js';

vi.mock('./process.js', () => ({ runProcess: vi.fn() }));
const run = vi.mocked(runProcess);
const comment = { path: 'src/file.ts', line: 4, side: 'RIGHT' as const, body: '**High: Lost update**\nA concurrent writer loses data.' };
const pending = { id: 'PRR_draft', databaseId: 42, viewerDidAuthor: true, comments: { totalCount: 1 } };
const success = (body: unknown) => ({ stdout: JSON.stringify(body), stderr: '', exitCode: 0 });
const lookup = (nodes: unknown[] = []) => success({ data: { repository: { pullRequest: { reviews: { nodes } } } } });
const payloads = () => run.mock.calls.flatMap(([, , options]) => options?.input ? [JSON.parse(options.input)] : []);
beforeEach(() => run.mockReset());

describe('GitHub draft review publication', () => {
  it('batches findings into a pending review without an event or a submission request', async () => {
    run.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(success({ id: 42, node_id: 'PRR_draft', state: 'PENDING' }));
    expect(await postPullRequestReview('Acme/repo', 1, 'abcdef1234', 'Summary', [comment], 'Chris', true))
      .toEqual({ id: 'PRR_draft', databaseId: 42, comments: 1 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![1]).toEqual(['api', '--method', 'POST', 'repos/Acme/repo/pulls/1/reviews', '--input', '-']);
    expect(payloads()[1]).toEqual({
      commit_id: 'abcdef1234', body: 'Summary\n\n—\nChris reviewed abcdef12',
      comments: [{ ...comment, body: `${comment.body}\n\n—\nChris reviewed abcdef12` }],
    });
  });

  it('preserves submitted COMMENT behavior when disabled and no draft exists', async () => {
    run.mockResolvedValueOnce(lookup()).mockResolvedValueOnce(success({ state: 'COMMENTED' }));
    await postPullRequestReview('Acme/repo', 1, 'abcdef1234', 'Summary', [comment]);
    expect(payloads()[1].event).toBe('COMMENT');
  });

  it('keeps clean results local when enabled', async () => {
    run.mockResolvedValueOnce(lookup());
    await postPullRequestReview('Acme/repo', 1, 'abcdef1234', 'Clean', [], '', true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('appends only new findings and never submits an existing draft (setting=%s)', async (enabled) => {
    run.mockResolvedValueOnce(lookup([{ ...pending, id: 'someone-else', viewerDidAuthor: false }, pending]))
      .mockResolvedValueOnce(success([[comment], [{ ...comment, line: 5, body: 'My hand-written comment' }]]))
      .mockResolvedValueOnce(success({ data: { addPullRequestReviewThread: { thread: { id: 'thread' } } } }));
    const fresh = { ...comment, line: 9 };
    expect(await postPullRequestReview('Acme/repo', 1, 'newhead1234', 'New summary', [comment, fresh], '', enabled))
      .toEqual({ id: pending.id, databaseId: 42, comments: 3 });
    expect(run).toHaveBeenCalledTimes(3);
    expect(payloads()[1]).toMatchObject({ variables: { input: { pullRequestReviewId: pending.id, path: fresh.path, line: 9, side: 'RIGHT' } } });
    expect(payloads()[1].query).toContain('addPullRequestReviewThread');
    expect(payloads()[1].variables.input.body).toContain('Reviewed newhead1');
    expect(JSON.stringify(payloads())).not.toContain('submitPullRequestReview');
    expect(JSON.stringify(payloads())).not.toContain('New summary');
    expect(JSON.stringify(payloads())).not.toContain('"event"');
  });

  it('fails closed if a human submits the draft while a new comment is being added', async () => {
    run.mockResolvedValueOnce(lookup([pending])).mockResolvedValueOnce(success([[]]))
      .mockResolvedValueOnce(success({ errors: [{ message: 'Review is no longer pending' }] }));
    await expect(postPullRequestReview('Acme/repo', 1, 'abcdef1234', 'Summary', [comment], '', true))
      .rejects.toThrow('no longer pending');
    expect(run).toHaveBeenCalledTimes(3);
    expect(payloads().every((payload) => !payload.event)).toBe(true);
  });

  it('never falls back to publishing when pending-review discovery fails', async () => {
    run.mockResolvedValueOnce({ stdout: '', stderr: 'GitHub unavailable', exitCode: 1 });
    await expect(postPullRequestReview('Acme/repo', 1, 'abcdef1234', 'Summary', [comment], '', true))
      .rejects.toThrow('GitHub unavailable');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate comments already saved before a partial failure', async () => {
    run.mockResolvedValueOnce(lookup([pending])).mockResolvedValueOnce(success([[comment]]));
    expect(await postPullRequestReview('Acme/repo', 1, 'abcdef1234', 'Summary', [comment], '', true))
      .toMatchObject({ id: pending.id, comments: 1 });
    expect(run).toHaveBeenCalledTimes(2);
  });
});

function contextResponse(state: 'PENDING' | 'COMMENTED' | 'DELETED') {
  const reviewComment = {
    ...comment, id: 'comment', databaseId: 12, fullDatabaseId: '12', url: 'https://github.com/Acme/repo/pull/1#discussion_r12',
    body: `${comment.body}\n\n—\nReviewed abcdef12`, originalLine: 4,
    createdAt: '2026-10-05T10:00:00Z', updatedAt: '2026-10-05T10:00:00Z',
    author: { login: 'me', __typename: 'User' }, authorAssociation: 'OWNER', pullRequestReview: { state },
  };
  return { data: { viewer: { login: 'me' }, repository: { pullRequest: {
    state: 'OPEN', mergedAt: null, reviewDecision: 'REVIEW_REQUIRED', headRefOid: 'abcdef1234',
    additions: 1, deletions: 0, author: { login: 'author' }, commits: { totalCount: 1 },
    latestReviews: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] },
    pendingReviews: { nodes: state === 'PENDING' ? [pending] : [] },
    reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: state === 'DELETED' ? [] : [{
      isResolved: false, isOutdated: false, comments: { nodes: [reviewComment] }, recentComments: { nodes: [reviewComment] },
    }] },
  } } } };
}

describe('GitHub pending review context', () => {
  it('counts drafts separately and only exposes findings to author feedback after human submission', async () => {
    run.mockResolvedValueOnce(success(contextResponse('PENDING')))
      .mockResolvedValueOnce(success(contextResponse('COMMENTED')))
      .mockResolvedValueOnce(success(contextResponse('DELETED')));
    const draft = await fetchPullRequestReviewContext('Acme/repo', 1);
    expect(draft.pendingReview).toEqual({ id: pending.id, databaseId: 42, comments: 1 });
    expect(draft.findings).toEqual([]);
    expect(draft.discussionWatermark).toBe('');
    const submitted = await fetchPullRequestReviewContext('Acme/repo', 1);
    expect(submitted.pendingReview).toBeNull();
    expect(submitted.findings).toHaveLength(1);
    const discarded = await fetchPullRequestReviewContext('Acme/repo', 1);
    expect(discarded.pendingReview).toBeNull();
    expect(discarded.findings).toEqual([]);
  });
});

describe('persisted draft lifecycle', () => {
  it.each(['COMMENTED', 'DELETED'] as const)('clears the pending indicator after a human %s action without re-queuing unchanged input', async (state) => {
    const database = new BarbarianDatabase(':memory:');
    try {
      database.connection.exec(`INSERT INTO review_queue (
        id, repository, number, title, url, author, head_sha, head_ref_name, base_ref_name,
        status, last_reviewed_sha, last_reviewed_watermark, first_seen_at, updated_at, last_seen_at
      ) VALUES ('review', 'Acme/repo', 1, 'Title', 'https://github.com/Acme/repo/pull/1', 'author',
        'abcdef1234', 'feature', 'main', 'ready_to_merge', 'abcdef1234', '', '', '', '')`);
      run.mockResolvedValueOnce(success(contextResponse('PENDING')))
        .mockResolvedValueOnce(success(contextResponse(state)));
      await refreshReviewContext(database, 'review');
      const row = () => database.connection.prepare('SELECT * FROM review_queue WHERE id=?').get('review')!;
      expect(row()).toMatchObject({ pending_review_id: 'PRR_draft', pending_review_comments: 1, findings_count: 0 });
      expect(database.connection.prepare('SELECT * FROM review_findings').all()).toEqual([]);
      expect(displayReviewStatus(row() as unknown as Parameters<typeof displayReviewStatus>[0])).toBe('pending_review');
      await refreshReviewContext(database, 'review');
      expect(row()).toMatchObject({ pending_review_id: null, pending_review_comments: 0, findings_count: state === 'COMMENTED' ? 1 : 0 });
      expect(displayReviewStatus(row() as unknown as Parameters<typeof displayReviewStatus>[0]))
        .toBe(state === 'COMMENTED' ? 'issues_found' : 'ready_to_merge');
      expect(reviewTrigger(row() as unknown as Parameters<typeof reviewTrigger>[0])).toBeNull();
    } finally { database.close(); }
  });
});
