import { describe, expect, it } from 'vitest';
import { repositoryBookmark, sortRepositoryBookmarks } from './repository-links';

describe('repository bookmarks', () => {
  it('sorts alphabetically by repository name rather than organization', () => {
    expect(sortRepositoryBookmarks([
      { name: 'Beta/zebra', url: 'z' },
      { name: 'Acme/alpha', url: 'a' },
      { name: 'Acme/Middle', url: 'm' },
    ]).map(({ name }) => name)).toEqual(['Acme/alpha', 'Acme/Middle', 'Beta/zebra']);
  });

  it('builds a safe GitHub repository URL', () => {
    expect(repositoryBookmark('Acme/repo name')).toEqual({
      name: 'Acme/repo name', url: 'https://github.com/Acme/repo%20name',
    });
  });
});
