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

export function restoredChatScrollTop(snapshot, { scrollTop = 0, clientHeight, scrollHeight }, anchor) {
  if (!snapshot || snapshot.pinned) return scrollHeight;
  const anchoredScrollTop = anchor ? scrollTop + anchor.afterTop - anchor.beforeTop : snapshot.scrollTop;
  return Math.min(Math.max(0, anchoredScrollTop), Math.max(0, scrollHeight - clientHeight));
}
