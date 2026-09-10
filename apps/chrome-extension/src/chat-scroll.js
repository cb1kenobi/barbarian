const bottomThreshold = 4;

export function isChatAtBottom({ scrollTop, clientHeight, scrollHeight }) {
  return scrollHeight <= clientHeight || scrollHeight - clientHeight - scrollTop <= bottomThreshold;
}

export function captureChatScroll(metrics) {
  return {
    scrollTop: metrics.scrollTop,
    pinned: isChatAtBottom(metrics),
  };
}

export function restoredChatScrollTop(snapshot, { clientHeight, scrollHeight }) {
  if (!snapshot || snapshot.pinned) return scrollHeight;
  return Math.min(snapshot.scrollTop, Math.max(0, scrollHeight - clientHeight));
}
