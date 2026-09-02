import { describe, expect, it } from 'vitest';
import { matchesQueueSearch } from './queue-search';

const item = {
  number: 2445,
  title: 'Restore subscription catch-up values',
  simple_summary: 'Backports the RocksDB audit log fix to the v5.2 release.',
};

describe('matchesQueueSearch', () => {
  it('matches number, title, and description without case sensitivity', () => {
    expect(matchesQueueSearch(item, '#2445')).toBe(true);
    expect(matchesQueueSearch(item, 'SUBSCRIPTION values')).toBe(true);
    expect(matchesQueueSearch(item, 'rocksdb v5.2')).toBe(true);
  });

  it('requires every search term to match', () => {
    expect(matchesQueueSearch(item, 'rocksdb missing')).toBe(false);
    expect(matchesQueueSearch(item, '   ')).toBe(true);
  });
});
