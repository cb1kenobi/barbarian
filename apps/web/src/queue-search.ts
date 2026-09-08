export interface SearchableQueueItem {
  number: number;
  title: string;
  simple_summary: string;
}

export interface QueueSearchShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export function isQueueSearchShortcut(event: QueueSearchShortcutEvent): boolean {
  return event.key.toLowerCase() === 'f'
    && (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey;
}

export function matchesQueueSearch(item: SearchableQueueItem, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `#${item.number} ${item.number} ${item.title} ${item.simple_summary}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}
