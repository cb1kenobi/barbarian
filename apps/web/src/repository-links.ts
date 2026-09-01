export interface RepositoryBookmark {
  name: string;
  url: string;
}

export function repositoryBookmark(name: string): RepositoryBookmark {
  return {
    name,
    url: `https://github.com/${name.split('/').map(encodeURIComponent).join('/')}`,
  };
}

function shortName(repository: string): string {
  return repository.split('/').at(-1) || repository;
}

export function sortRepositoryBookmarks(repositories: RepositoryBookmark[]): RepositoryBookmark[] {
  return [...repositories].sort((left, right) => shortName(left.name).localeCompare(shortName(right.name), undefined, { sensitivity: 'base' })
    || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }));
}
