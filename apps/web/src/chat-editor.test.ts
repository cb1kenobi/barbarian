import { describe, expect, it } from 'vitest';
import { restoreFailedChatMessage, shouldSubmitChat } from './chat-editor';

describe('review room keyboard behavior', () => {
  it('submits on Enter', () => {
    expect(shouldSubmitChat('Enter', false, false)).toBe(true);
  });

  it('keeps Shift+Enter available for a new line', () => {
    expect(shouldSubmitChat('Enter', true, false)).toBe(false);
  });

  it('does not submit while composed text is being confirmed', () => {
    expect(shouldSubmitChat('Enter', false, true)).toBe(false);
  });

  it('restores a failed message without overwriting a follow-up draft', () => {
    expect(restoreFailedChatMessage('Failed send', '')).toBe('Failed send');
    expect(restoreFailedChatMessage('Failed send', 'New draft')).toBe('Failed send\n\nNew draft');
  });
});
