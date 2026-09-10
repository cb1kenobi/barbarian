import { describe, expect, it } from 'vitest';
import { renderChatPendingMessage } from './chat-pending.js';

describe('review room pending message', () => {
  it('announces a visible working state without announcing the spinner', () => {
    const markup = renderChatPendingMessage();
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('Agent is working…');
  });
});
