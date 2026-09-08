import { describe, expect, it } from 'vitest';
import { isQueueSearchShortcut, matchesQueueSearch } from './queue-search';

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

describe('isQueueSearchShortcut', () => {
  const keyboard = (overrides: Partial<Parameters<typeof isQueueSearchShortcut>[0]> = {}) => ({
    key: 'f', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides,
  });

  it('accepts the standard macOS and cross-platform find shortcuts', () => {
    expect(isQueueSearchShortcut(keyboard({ metaKey: true }))).toBe(true);
    expect(isQueueSearchShortcut(keyboard({ ctrlKey: true }))).toBe(true);
  });

  it('ignores plain and modified F keystrokes', () => {
    expect(isQueueSearchShortcut(keyboard())).toBe(false);
    expect(isQueueSearchShortcut(keyboard({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isQueueSearchShortcut(keyboard({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isQueueSearchShortcut(keyboard({ key: 'g', metaKey: true }))).toBe(false);
  });
});
