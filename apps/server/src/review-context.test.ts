import { describe, expect, it } from 'vitest';
import { buildReviewAssessment, type StoredReviewFinding } from './review-context.js';

const review = {
  status: 'issues_found', remote_state: 'OPEN', is_draft: 0, review_decision: 'REVIEW_REQUIRED',
  viewer_review_state: null, viewer_review_sha: null, other_approvals: 0,
  findings_count: 2, head_sha: 'new', last_reviewed_sha: 'new',
};

function finding(resolved: boolean, outdated = false): StoredReviewFinding {
  return {
    id: String(resolved), review_id: 'review', remote_id: resolved ? 1 : 2, author: 'claude',
    body: 'body', summary: 'summary', url: 'https://example.test', path: 'file.ts', line: 10,
    resolved, outdated, created_at: '', updated_at: '',
  };
}

describe('buildReviewAssessment', () => {
  it('reports the number of unresolved AI comments', () => {
    const assessment = buildReviewAssessment(review, [finding(true), finding(false)]);
    expect(assessment.label).toBe('Needs Fixes');
    expect(assessment.counts).toMatchObject({ total: 2, open: 1, resolved: 1 });
    expect(assessment.message).toBe('1 of 2 AI review comments are still open.');
  });

  it('puts merged state ahead of review findings', () => {
    const assessment = buildReviewAssessment({ ...review, status: 'merged', remote_state: 'MERGED' }, [finding(false)]);
    expect(assessment.label).toBe('Merged');
  });

  it('does not call outdated comments resolved', () => {
    const assessment = buildReviewAssessment({ ...review, findings_count: 0 }, [finding(false, true)]);
    expect(assessment.counts).toMatchObject({ open: 0, resolved: 0, outdated: 1 });
    expect(assessment.message).toContain('became outdated');
  });

  it('calls another reviewer approval partial instead of approved', () => {
    const assessment = buildReviewAssessment({
      ...review, status: 'unreviewed', review_decision: 'APPROVED', other_approvals: 1, findings_count: 0,
    }, []);
    expect(assessment.label).toBe('Partially Reviewed');
    expect(assessment.message).toContain('your approval is still pending');
  });

  it('labels my current-head approval without implying another reviewer approved it', () => {
    const assessment = buildReviewAssessment({
      ...review, status: 'approved', viewer_review_state: 'APPROVED', viewer_review_sha: 'new', findings_count: 0,
    }, []);
    expect(assessment.label).toBe('Approved');
  });
});
