export type ReviewSort = 'priority' | 'oldest' | 'newest' | 'repository';

export interface SortableReview {
  priority_score: number;
  remote_created_at: string;
  updated_at: string;
  repository: string;
  number: number;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortReviews<T extends SortableReview>(reviews: T[], sort: ReviewSort): T[] {
  return [...reviews].sort((left, right) => {
    if (sort === 'oldest') {
      return timestamp(left.remote_created_at) - timestamp(right.remote_created_at)
        || left.repository.localeCompare(right.repository)
        || left.number - right.number;
    }
    if (sort === 'newest') {
      return timestamp(right.remote_created_at) - timestamp(left.remote_created_at)
        || left.repository.localeCompare(right.repository)
        || right.number - left.number;
    }
    if (sort === 'repository') {
      return left.repository.localeCompare(right.repository)
        || timestamp(right.updated_at) - timestamp(left.updated_at)
        || right.number - left.number;
    }
    return right.priority_score - left.priority_score
      || timestamp(right.updated_at) - timestamp(left.updated_at)
      || left.repository.localeCompare(right.repository)
      || right.number - left.number;
  });
}
