import { describe, expect, it } from 'vitest';
import { extractLinearClosingReferences, fixedIssueReferences } from './fixed-issues.js';

describe('fixed issue references', () => {
  it('turns GitHub closing references into issue links and removes duplicates', () => {
    expect(fixedIssueReferences('HarperFast/rocksdb-js', '', [1, 2, 1])).toEqual([
      { provider: 'github', identifier: '#1', url: 'https://github.com/HarperFast/rocksdb-js/issues/1' },
      { provider: 'github', identifier: '#2', url: 'https://github.com/HarperFast/rocksdb-js/issues/2' },
    ]);
  });

  it('supports explicit Linear closing directives and multiple identifiers', () => {
    expect(extractLinearClosingReferences(`
Fixes ENG-123, ENG-456 and ENG-789
Closes https://linear.app/harper/issue/OPS-22/fix-the-widget
Resolves [DATA-7](https://linear.app/harper/issue/DATA-7/data-loss)
    `)).toEqual([
      { provider: 'linear', identifier: 'ENG-123', url: null },
      { provider: 'linear', identifier: 'ENG-456', url: null },
      { provider: 'linear', identifier: 'ENG-789', url: null },
      { provider: 'linear', identifier: 'OPS-22', url: 'https://linear.app/harper/issue/OPS-22/fix-the-widget' },
      { provider: 'linear', identifier: 'DATA-7', url: 'https://linear.app/harper/issue/DATA-7/data-loss' },
    ]);
  });

  it('ignores ordinary mentions, backlinks, and identifiers after prose', () => {
    expect(extractLinearClosingReferences(`
Mentions ENG-1 and ENG-2.
ENG-3 links to this PR.
This PR is also mentioned by another PR.
Fixes ENG-4. See ENG-5 for follow-up work.
This fixes a race described in ENG-6.
    `)).toEqual([
      { provider: 'linear', identifier: 'ENG-4', url: null },
    ]);
  });

  it('deduplicates Linear identifiers across directives', () => {
    expect(extractLinearClosingReferences('Fixes eng-12\nResolves ENG-12')).toEqual([
      { provider: 'linear', identifier: 'ENG-12', url: null },
    ]);
  });
});
