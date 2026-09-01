export type WorkSort = 'in-progress' | 'priority' | 'updated';

export interface SortableWorkItem {
  repository: string;
  number: number;
  priority: number;
  in_progress: boolean;
  updated_at: string;
}

function byPriority(left: SortableWorkItem, right: SortableWorkItem): number {
  return right.priority - left.priority
    || right.updated_at.localeCompare(left.updated_at)
    || left.repository.localeCompare(right.repository)
    || left.number - right.number;
}

export function sortWorkItems<T extends SortableWorkItem>(items: T[], sort: WorkSort): T[] {
  return [...items].sort((left, right) => {
    if (sort === 'in-progress') {
      return Number(right.in_progress) - Number(left.in_progress) || byPriority(left, right);
    }
    if (sort === 'updated') {
      return right.updated_at.localeCompare(left.updated_at) || byPriority(left, right);
    }
    return byPriority(left, right);
  });
}
