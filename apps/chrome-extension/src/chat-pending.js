export function renderChatPendingMessage() {
  return '<div class="message assistant chat-pending" role="status" aria-live="polite"><span class="message-author">Agent</span><div class="chat-pending-state"><span class="chat-pending-spinner" aria-hidden="true"></span><span>Agent is working…</span></div></div>';
}

export function reconcileChatReply(messages = [], reply) {
  const existingIndex = reply?.id === undefined ? -1 : messages.findIndex((message) => message.id === reply.id);
  if (existingIndex < 0) return { messages, existingIndex, shouldAppend: Boolean(reply) };
  const reconciled = [...messages];
  reconciled[existingIndex] = reply;
  return { messages: reconciled, existingIndex, shouldAppend: false };
}
