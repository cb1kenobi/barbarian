import { describe, expect, it } from 'vitest';
import { compareAlphabetically, formatLabels, parseLabels, splitItems, timezoneOptions } from './settings';

describe('settings form helpers', () => {
  it('round-trips repository label weights', () => {
    const labels = { security: 80, regression: 60, cleanup: -5 };
    expect(parseLabels(formatLabels(labels))).toEqual(labels);
  });

  it('rejects malformed label weights instead of silently changing config', () => {
    expect(() => parseLabels('security = high')).toThrow('security: 80');
  });

  it('splits comma- and newline-delimited config lists', () => {
    expect(splitItems('Developers, Front End\nRelease')).toEqual(['Developers', 'Front End', 'Release']);
  });

  it('always includes the current timezone', () => {
    expect(timezoneOptions('UTC')).toContain('UTC');
  });

  it('sorts provider and model labels alphabetically without regard to case', () => {
    expect(['Gemini', 'claude', 'Codex'].sort(compareAlphabetically)).toEqual(['claude', 'Codex', 'Gemini']);
  });
});
