import { describe, expect, it } from 'vitest';
import {
  authoredReviewCardStatuses,
  authoredReviewDisplayStatus,
  countReviewsNeedingApproval,
  reviewCardStatuses,
  reviewDisplayStatus,
  reviewStatusGuide,
  statusLabel,
  statusTone,
} from './review-display';

describe('review display status', () => {
  it('shows authored PR review progress independently from external approval', () => {
    expect(authoredReviewCardStatuses({ status: 'unreviewed' })).toEqual(['ai_unreviewed']);
    expect(statusLabel('ai_unreviewed')).toBe('AI not reviewed');
    expect(authoredReviewCardStatuses({ status: 'agent_working' })).toEqual(['agent_working']);
    expect(authoredReviewCardStatuses({ status: 'agent_failed' })).toEqual(['agent_failed']);
    expect(authoredReviewCardStatuses({ status: 'issues_found' })).toEqual(['issues_found']);
    expect(authoredReviewCardStatuses({ status: 'ready_to_merge', display_status: 'partially_reviewed', head_sha: 'head', last_reviewed_sha: 'head' }))
      .toEqual(['review_clean']);
    expect(authoredReviewCardStatuses({ status: 'ready_to_merge' })).toEqual(['ai_unreviewed']);
    expect(authoredReviewCardStatuses({ status: 'ready_to_merge', head_sha: 'head', last_reviewed_sha: 'old-head' }))
      .toEqual(['ai_unreviewed']);
    expect(authoredReviewDisplayStatus({ approved: false, has_review_activity: true })).toBe('awaiting_approval');
    expect(statusLabel('review_clean')).toBe('AI review clean');
    expect(statusTone('review_clean')).toBe('ready');
    expect(authoredReviewCardStatuses({ status: 'agent_working', pending_review_id: 'draft' }))
      .toEqual(['agent_working', 'pending_review']);
    expect(authoredReviewCardStatuses({ status: 'ready_to_merge', pending_review_id: 'draft' }))
      .toEqual(['pending_review']);
  });
  it('distinguishes authored PRs awaiting their first review from those awaiting approval', () => {
    expect(authoredReviewDisplayStatus({})).toBe('awaiting_review');
    expect(authoredReviewDisplayStatus({ has_review_activity: true })).toBe('awaiting_approval');
    expect(authoredReviewDisplayStatus({ approved: true, has_review_activity: true })).toBe('approved');
    expect(authoredReviewDisplayStatus({ approved: true, has_new_feedback: true })).toBe('new_feedback');
    expect(authoredReviewDisplayStatus({ has_new_feedback: true, needs_input: true })).toBe('needs_input');
    expect(statusLabel('awaiting_approval')).toBe('Awaiting approval');
  });

  it('uses the computed display status when the server provides it', () => {
    expect(reviewDisplayStatus({ status: 'unreviewed', display_status: 'partially_reviewed' }))
      .toBe('partially_reviewed');
  });

  it('keeps an agent failure visible when another display status would mask it', () => {
    expect(reviewCardStatuses({ status: 'agent_failed', display_status: 'approved' }))
      .toEqual(['agent_failed', 'approved']);
    expect(reviewCardStatuses({ status: 'agent_failed', display_status: 'agent_failed' }))
      .toEqual(['agent_failed']);
  });

  it('supports payloads from servers that do not provide display_status yet', () => {
    const status = reviewDisplayStatus({ status: 'issues_found' });
    expect(status).toBe('issues_found');
    expect(statusLabel(status)).toBe('Issues found');
    expect(statusTone(status)).toBe('feedback');
  });

  it('uses a safe default for malformed or incomplete records', () => {
    expect(reviewDisplayStatus({})).toBe('unreviewed');
    expect(statusLabel(undefined)).toBe('Needs review');
    expect(statusLabel('approved')).toBe('Approved');
  });

  it('counts every ready review except drafts and PRs approved by the current user', () => {
    expect(countReviewsNeedingApproval([
      { status: 'unreviewed' },
      { status: 'ready_to_merge' },
      { status: 'approved' },
      { status: 'unreviewed', display_status: 'draft' },
      { status: 'approved', display_status: 'unreviewed' },
    ])).toBe(3);
  });

  it('documents every PR status shown by the dashboard', () => {
    expect(reviewStatusGuide.map(({ status }) => status)).toEqual([
      'pending_review', 'draft', 'unreviewed', 'agent_working', 'agent_failed', 'issues_found', 'awaiting_feedback',
      'ready_to_merge', 'partially_reviewed', 'approved', 'merged', 'closed',
    ]);
    expect(reviewStatusGuide.every(({ status, description }) => statusLabel(status) && description.length > 10)).toBe(true);
  });
  it('keeps pending human review visible alongside a running agent', () => {
    expect(reviewCardStatuses({ status: 'agent_working', display_status: 'pending_review', pending_review_id: 'PRR_1' }))
      .toEqual(['agent_working', 'pending_review']);
  });

});
