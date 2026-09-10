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

export function restoredChatScrollTop(snapshot, { clientHeight, scrollHeight }, anchorDelta = 0) {
  if (!snapshot || snapshot.pinned) return scrollHeight;
  return Math.min(Math.max(0, snapshot.scrollTop + anchorDelta), Math.max(0, scrollHeight - clientHeight));
}
