import { describe, expect, it } from 'vitest';
import {
  countReviewsNeedingApproval,
  reviewDisplayStatus,
  reviewStatusGuide,
  statusLabel,
  statusTone,
} from './review-display';

describe('review display status', () => {
  it('uses the computed display status when the server provides it', () => {
    expect(reviewDisplayStatus({ status: 'unreviewed', display_status: 'partially_reviewed' }))
      .toBe('partially_reviewed');
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

  it('counts every review except PRs approved by the current user', () => {
    expect(countReviewsNeedingApproval([
      { status: 'unreviewed' },
      { status: 'ready_to_merge' },
      { status: 'approved' },
      { status: 'approved', display_status: 'unreviewed' },
    ])).toBe(3);
  });

  it('documents every PR status shown by the dashboard', () => {
    expect(reviewStatusGuide.map(({ status }) => status)).toEqual([
      'unreviewed', 'agent_working', 'agent_failed', 'issues_found', 'awaiting_feedback',
      'ready_to_merge', 'partially_reviewed', 'approved', 'merged', 'closed',
    ]);
    expect(reviewStatusGuide.every(({ status, description }) => statusLabel(status) && description.length > 10)).toBe(true);
  });
});
