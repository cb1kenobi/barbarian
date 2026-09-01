import { describe, expect, it } from 'vitest';
import { countFindingSeverities, findingSeverity } from './review-card-metadata.js';

describe('findingSeverity', () => {
  it('recognizes the review formats already stored by Barbarian and GitHub agents', () => {
    expect(findingSeverity('**High: corrupts shared state**')).toBe('high');
    expect(findingSeverity('Severity: blocker. This can lose writes.')).toBe('high');
    expect(findingSeverity('![medium](https://example.test/medium-priority.svg)')).toBe('medium');
    expect(findingSeverity('**Low: simplify the cleanup**')).toBe('low');
    expect(findingSeverity('Suggestion (non-blocking): rename this value')).toBe('low');
    expect(findingSeverity('Nit: use the existing helper')).toBe('low');
  });

  it('keeps an explicit high severity when the explanation mentions a non-blocking alternative', () => {
    expect(findingSeverity('**High: data loss**. A non-blocking alternative is available.')).toBe('high');
  });

  it('defaults an unlabelled actionable finding to medium instead of dropping it', () => {
    expect(findingSeverity('This throws when the collection is empty.')).toBe('medium');
  });
});

describe('countFindingSeverities', () => {
  it('returns a complete category total', () => {
    expect(countFindingSeverities([
      { body: 'Blocker: data loss' },
      { body: 'P2: wrong response' },
      { body: 'Nit: naming' },
      { body: 'Suggestion (non-blocking)' },
    ])).toEqual({ high: 1, medium: 1, low: 2 });
  });
});
