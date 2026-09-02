import { describe, expect, it } from 'vitest';
import { formatLastSync, formatNextSync, formatSyncTimestamp } from './sync-time';

describe('sync timing labels', () => {
  it('shows whole minutes since the last completed sync', () => {
    const now = Date.parse('2026-08-31T14:45:01.000Z');
    expect(formatLastSync({ status: 'complete', finished_at: '2026-08-31T14:42:37.000Z', error: null }, now))
      .toBe('Last sync 2 min ago');
  });

  it('provides an exact timestamp for the hover title', () => {
    expect(formatSyncTimestamp('2026-08-31T14:42:37.000Z', 'UTC')).toBe('Aug 31, 2:42 PM');
  });

  it('rounds the next sync countdown up to whole minutes', () => {
    const now = Date.parse('2026-08-31T14:42:37.000Z');
    expect(formatNextSync('2026-08-31T14:44:01.000Z', now)).toBe('Next sync in 2 min');
  });

  it('shows active and due states without seconds', () => {
    expect(formatNextSync(null)).toBe('Next sync right now');
    expect(formatNextSync('2026-08-31T14:42:37.000Z', Date.parse('2026-08-31T14:42:38.000Z')))
      .toBe('Next sync due now');
  });
});
