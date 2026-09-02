export interface SyncRun {
  status: string;
  finished_at: string | null;
  error: string | null;
}

export function formatLastSync(lastSync: SyncRun | null, now = Date.now()): string {
  if (!lastSync?.finished_at) return 'No sync completed yet';
  const finishedAt = new Date(lastSync.finished_at).getTime();
  if (!Number.isFinite(finishedAt)) return 'Last sync time unknown';
  const minutes = Math.max(0, Math.floor((now - finishedAt) / 60_000));
  const elapsed = minutes < 1 ? '<1 min ago' : `${minutes} min ago`;
  return lastSync.status === 'failed' ? `Last failed ${elapsed}` : `Last sync ${elapsed}`;
}

export function formatSyncTimestamp(value: string | null | undefined, timezone?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

export function formatNextSync(nextSyncAt: string | null, now = Date.now()): string {
  if (!nextSyncAt) return 'Next sync right now';
  const remaining = new Date(nextSyncAt).getTime() - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return 'Next sync due now';
  return `Next sync in ${Math.max(1, Math.ceil(remaining / 60_000))} min`;
}
