import { describe, expect, it } from 'vitest';
import { captureChatScroll, isChatAtBottom, restoredChatScrollTop } from './chat-scroll.js';

describe('review room scroll position', () => {
  it('pins an initial, short, exact-bottom, or fractionally-bottomed conversation', () => {
    expect(restoredChatScrollTop(undefined, { clientHeight: 200, scrollHeight: 600 })).toBe(600);
    expect(isChatAtBottom({ scrollTop: 0, clientHeight: 200, scrollHeight: 180 })).toBe(true);
    expect(isChatAtBottom({ scrollTop: 400, clientHeight: 200, scrollHeight: 600 })).toBe(true);
    expect(isChatAtBottom({ scrollTop: 396.5, clientHeight: 200, scrollHeight: 600 })).toBe(true);
  });

  it('preserves a reader position when content grows without pinning', () => {
    const snapshot = captureChatScroll({ scrollTop: 120, clientHeight: 200, scrollHeight: 600 });
    expect(snapshot.pinned).toBe(false);
    expect(restoredChatScrollTop(snapshot, { clientHeight: 200, scrollHeight: 900 })).toBe(120);
  });

  it('clamps a reader position when content shrinks or the viewport grows', () => {
    const snapshot = captureChatScroll({ scrollTop: 350, clientHeight: 200, scrollHeight: 700 });
    expect(restoredChatScrollTop(snapshot, { clientHeight: 300, scrollHeight: 500 })).toBe(200);
  });

  it('keeps a pinned conversation at the new bottom when content grows', () => {
    const snapshot = captureChatScroll({ scrollTop: 400, clientHeight: 200, scrollHeight: 600 });
    expect(restoredChatScrollTop(snapshot, { clientHeight: 200, scrollHeight: 900 })).toBe(900);
  });

  it('keeps a surviving message anchored when older rows leave the window', () => {
    const snapshot = captureChatScroll({ scrollTop: 240, clientHeight: 200, scrollHeight: 800 });
    const anchor = { beforeTop: 60, afterTop: 140 };
    expect(restoredChatScrollTop(snapshot, { scrollTop: 0, clientHeight: 200, scrollHeight: 640 }, anchor)).toBe(80);
  });
});
