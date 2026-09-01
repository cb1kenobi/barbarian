import { describe, expect, it } from 'vitest';
import { sortWorkItems } from './work-sort';

const items = [
  { repository: 'Acme/core', number: 1, priority: 200, in_progress: false, updated_at: '2026-08-01T00:00:00Z' },
  { repository: 'Acme/core', number: 2, priority: 20, in_progress: true, updated_at: '2026-08-03T00:00:00Z' },
  { repository: 'Acme/core', number: 3, priority: 100, in_progress: false, updated_at: '2026-08-04T00:00:00Z' },
];

describe('sortWorkItems', () => {
  it('puts active work first, then uses priority', () => {
    expect(sortWorkItems(items, 'in-progress').map((item) => item.number)).toEqual([2, 1, 3]);
  });

  it('can sort strictly by priority or update time', () => {
    expect(sortWorkItems(items, 'priority').map((item) => item.number)).toEqual([1, 3, 2]);
    expect(sortWorkItems(items, 'updated').map((item) => item.number)).toEqual([3, 2, 1]);
  });
});
