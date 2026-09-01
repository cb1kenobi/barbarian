import { describe, expect, it } from 'vitest';
import { shouldSubmitQuestion } from './chat-input.js';

describe('Chrome extension Review Room input', () => {
  it('submits with Enter', () => {
    expect(shouldSubmitQuestion('Enter', false, false)).toBe(true);
  });

  it('keeps Shift+Enter available for a new line', () => {
    expect(shouldSubmitQuestion('Enter', true, false)).toBe(false);
  });

  it('does not submit while composed text is being confirmed', () => {
    expect(shouldSubmitQuestion('Enter', false, true)).toBe(false);
  });
});
