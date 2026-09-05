export function shouldSubmitChat(key: string, shiftKey: boolean, isComposing: boolean): boolean {
  return key === 'Enter' && !shiftKey && !isComposing;
}

export function restoreFailedChatMessage(failed: string, current: string): string {
  return current ? `${failed}\n\n${current}` : failed;
}
