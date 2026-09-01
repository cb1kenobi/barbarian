import { describe, expect, it } from 'vitest';
import { sortReviews, type SortableReview } from './review-sort';

const reviews: Array<SortableReview & { id: string }> = [
  { id: 'b-new', priority_score: 1_000, remote_created_at: '2026-02-01T00:00:00Z', updated_at: '2026-03-02T00:00:00Z', repository: 'Org/beta', number: 2 },
  { id: 'a-old', priority_score: 6_000, remote_created_at: '2026-01-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z', repository: 'Org/alpha', number: 1 },
  { id: 'a-new', priority_score: 0, remote_created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-03T00:00:00Z', repository: 'Org/alpha', number: 3 },
];

describe('sortReviews', () => {
  it('supports computed priority, oldest, newest, and repository ordering', () => {
    expect(sortReviews(reviews, 'priority').map((review) => review.id)).toEqual(['a-old', 'b-new', 'a-new']);
    expect(sortReviews(reviews, 'oldest').map((review) => review.id)).toEqual(['a-old', 'b-new', 'a-new']);
    expect(sortReviews(reviews, 'newest').map((review) => review.id)).toEqual(['a-new', 'b-new', 'a-old']);
    expect(sortReviews(reviews, 'repository').map((review) => review.id)).toEqual(['a-new', 'a-old', 'b-new']);
  });
});
