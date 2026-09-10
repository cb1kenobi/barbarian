import { describe, expect, it } from 'vitest';
import { reconcileChatReply, renderChatPendingMessage } from './chat-pending.js';

describe('review room pending message', () => {
  it('announces a visible working state without announcing the spinner', () => {
    const markup = renderChatPendingMessage();
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('Agent is working…');
  });

  it('replaces a truncated refresh copy with the complete reply', () => {
    const truncated = { id: 7, role: 'assistant', content: 'short' };
    const complete = { id: 7, role: 'assistant', content: 'complete response' };
    const result = reconcileChatReply([truncated], complete);
    expect(result).toEqual({ messages: [complete], existingIndex: 0, shouldAppend: false });
  });

  it('appends a reply that has not arrived through a refresh', () => {
    const reply = { id: 8, role: 'assistant', content: 'response' };
    expect(reconcileChatReply([], reply)).toEqual({ messages: [], existingIndex: -1, shouldAppend: true });
  });
});
