import { describe, expect, it } from 'vitest';
import { greetingForTime } from './greeting';

describe('dashboard greeting', () => {
  const utcTime = (hour: number) => Date.parse(`2026-09-03T${String(hour).padStart(2, '0')}:00:00.000Z`);

  it.each([
    [0, 'Go to bed'],
    [4, 'Go to bed'],
    [5, 'Good morning'],
    [11, 'Good morning'],
    [12, 'Good afternoon'],
    [17, 'Good afternoon'],
    [18, 'Good evening'],
    [23, 'Good evening'],
  ])('uses the correct greeting at %i:00', (hour, expected) => {
    expect(greetingForTime(utcTime(hour), 'UTC')).toBe(expected);
  });

  it('uses the configured timezone', () => {
    expect(greetingForTime(Date.parse('2026-09-03T08:00:00.000Z'), 'America/Chicago')).toBe('Go to bed');
  });
});
