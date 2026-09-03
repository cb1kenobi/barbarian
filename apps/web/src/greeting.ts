export function greetingForTime(value: Date | number, timezone?: string): string {
  const date = value instanceof Date ? value : new Date(value);
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(date).find(({ type }) => type === 'hour')?.value);

  if (hour < 5) return 'Go to bed';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
