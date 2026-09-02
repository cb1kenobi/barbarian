import { describe, expect, it } from 'vitest';
import {
  assignedToViewerOrUnassigned,
  discussionWatermark,
  isAiReviewComment,
  priorityFor,
  reviewAttribution,
  reviewPublication,
  reviewPublicationPayload,
  reviewableDiffLines,
  validateReviewCommentLocations,
  type DiscussionEntry,
  type GithubDiscussionNode,
  type GithubIssueNode,
} from './github.js';

function issue(overrides: Partial<GithubIssueNode> = {}): GithubIssueNode {
  return {
    number: 1,
    title: 'Routine issue',
    body: '',
    url: 'https://example.test/1',
    updatedAt: '2026-09-01T00:00:00Z',
    assignees: { nodes: [] },
    labels: { nodes: [] },
    milestone: null,
    closedByPullRequestsReferences: { nodes: [] },
    ...overrides,
  };
}

function entry(id: string, login: string, updatedAt: string, authorAssociation = 'NONE'): DiscussionEntry {
  return { id, fullDatabaseId: id, updatedAt, author: { login }, authorAssociation };
}

function node(entries: DiscussionEntry[]): GithubDiscussionNode {
  return {
    number: 1,
    author: { login: 'pull-author' },
    comments: { nodes: entries },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
  };
}

describe('discussionWatermark', () => {
  it('tracks PR-author and collaborator feedback while excluding the authenticated reviewer', () => {
    const watermark = discussionWatermark(node([
      entry('10', 'cb1kenobi', '2026-09-01T10:00:00Z', 'OWNER'),
      entry('11', 'random-reader', '2026-09-01T11:00:00Z'),
      entry('12', 'pull-author', '2026-09-01T12:00:00Z'),
      entry('13', 'maintainer', '2026-09-01T13:00:00Z', 'MEMBER'),
    ]), 'cb1kenobi');
    expect(watermark).toContain('2026-09-01T13:00:00Z');
    expect(watermark).toContain('13');
  });

  it('is unchanged by self-authored or untrusted discussion', () => {
    expect(discussionWatermark(node([
      entry('1', 'cb1kenobi', '2026-09-01T10:00:00Z', 'OWNER'),
      entry('2', 'random-reader', '2026-09-01T11:00:00Z'),
    ]), 'cb1kenobi')).toBe('');
  });
});

describe('issue discovery signals', () => {
  it('includes issues assigned to the viewer or nobody, but not issues assigned only to someone else', () => {
    expect(assignedToViewerOrUnassigned(issue(), 'cb1kenobi')).toBe(true);
    expect(assignedToViewerOrUnassigned(issue({ assignees: { nodes: [{ login: 'cb1kenobi' }] } }), 'cb1kenobi')).toBe(true);
    expect(assignedToViewerOrUnassigned(issue({ assignees: { nodes: [{ login: 'someone-else' }] } }), 'cb1kenobi')).toBe(false);
  });

  it('raises priority for standard severity labels and data-integrity risk', () => {
    const priority = priorityFor(issue({
      title: 'Prevent data loss during recovery',
      labels: { nodes: [{ name: 'P1' }] },
      milestone: { title: 'v6.0' },
    }), {
      name: 'Acme/core', priority: 10, watchIssues: true, watchPullRequests: true,
      reviewSkill: 'cb1-code-review', labels: {},
    });
    expect(priority.score).toBe(310);
    expect(priority.reasons).toEqual([
      'repository +10', 'data integrity +150', 'milestone +30', 'P1 / high +120',
    ]);
  });

  it('gets repository priority from configuration without repository-name bonuses', () => {
    const priority = priorityFor(issue(), {
      name: 'HarperFast/rocksdb-js', priority: 17, watchIssues: true, watchPullRequests: true,
      reviewSkill: 'cb1-code-review', labels: {},
    });
    expect(priority).toEqual({ score: 17, reasons: ['repository +17'] });
  });
});

describe('reviewableDiffLines', () => {
  const diff = `diff --git a/src/file.ts b/src/file.ts
--- a/src/file.ts
+++ b/src/file.ts
@@ -10,3 +10,3 @@
 context
-removed
+added
 context`;

  it('distinguishes deleted lines from added and context lines', () => {
    const lines = reviewableDiffLines(diff);
    expect(lines.has(['src/file.ts', 'RIGHT', '10'].join('\0'))).toBe(true);
    expect(lines.has(['src/file.ts', 'LEFT', '11'].join('\0'))).toBe(true);
    expect(lines.has(['src/file.ts', 'RIGHT', '11'].join('\0'))).toBe(true);
    expect(lines.has(['src/file.ts', 'RIGHT', '12'].join('\0'))).toBe(true);
  });

  it('rejects comments outside the supplied diff', () => {
    expect(() => validateReviewCommentLocations(diff, [
      { path: 'src/file.ts', line: 11, side: 'RIGHT', body: 'Confirmed issue.' },
    ])).not.toThrow();
    expect(() => validateReviewCommentLocations(diff, [
      { path: 'other.ts', line: 1, side: 'RIGHT', body: 'Not in diff.' },
    ])).toThrow('does not point');
  });
});

describe('reviewPublicationPayload', () => {
  it('uses anonymous review attribution by default', () => {
    const payload = reviewPublicationPayload('1234567890', [
      { path: 'file.ts', line: 2, side: 'RIGHT', body: '**High: broken invariant**\n\nFailure mode.' },
    ]);
    expect(payload).not.toHaveProperty('body');
    expect(payload.comments[0]?.body).toContain('—\nReviewed 12345678');
    expect(payload.comments[0]?.body).not.toContain('Barbarian');
  });

  it('uses the configured review name and replaces agent-supplied attribution', () => {
    const payload = reviewPublicationPayload('abcdef123456', [
      {
        path: 'file.ts', line: 2, side: 'RIGHT',
        body: '**High: broken invariant**\n\nFailure mode.\n\n—\n_Generated by Barber AI_',
      },
    ], 'CB1');
    expect(payload.comments[0]?.body).toContain('—\nCB1 reviewed abcdef12');
    expect(payload.comments[0]?.body).not.toContain('Generated by');
    expect(reviewAttribution('abcdef123456', '  ')).toBe('Reviewed abcdef12');
    expect(isAiReviewComment('developer', payload.comments[0]?.body || '')).toBe(true);
  });

  it('refuses to publish clean results to GitHub', () => {
    expect(() => reviewPublication('Acme/repo', 12, '1234567890', 'The change is safe.', []))
      .toThrow('Refusing to publish a clean review comment');
  });

  it('publishes inline findings as a grouped pull request review', () => {
    const publication = reviewPublication('Acme/repo', 12, '1234567890', 'One issue.', [
      { path: 'file.ts', line: 2, side: 'RIGHT', body: 'Confirmed issue.' },
    ]);
    expect(publication.endpoint).toBe('repos/Acme/repo/pulls/12/reviews');
  });

  it('cannot accidentally publish an empty submitted review', () => {
    expect(() => reviewPublicationPayload('1234567890', []))
      .toThrow('Refusing to publish an empty pull request review');
  });
});
