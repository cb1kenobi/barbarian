import { describe, expect, it } from 'vitest';
import { formatElapsed } from './elapsed-time';

describe('formatElapsed', () => {
  const now = Date.parse('2026-09-02T12:00:00Z');

  it('keeps exact whole minutes in compact day and hour forms', () => {
    expect(formatElapsed('2026-09-01T08:47:00Z', now)).toBe('1d 3h 13m');
    expect(formatElapsed('2026-09-02T03:09:00Z', now)).toBe('8h 51m');
    expect(formatElapsed('2026-09-02T11:48:00Z', now)).toBe('12m');
  });

  it('uses zero minutes for current/future timestamps and a dash when unavailable', () => {
    expect(formatElapsed('2026-09-02T12:00:30Z', now)).toBe('0m');
    expect(formatElapsed(null, now)).toBe('—');
    expect(formatElapsed('not-a-date', now)).toBe('—');
  });
});
