export interface SearchableQueueItem {
  number: number;
  title: string;
  simple_summary: string;
}

export function matchesQueueSearch(item: SearchableQueueItem, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `#${item.number} ${item.number} ${item.title} ${item.simple_summary}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}
