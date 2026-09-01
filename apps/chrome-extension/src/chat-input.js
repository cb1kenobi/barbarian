export function shouldSubmitQuestion(key, shiftKey, isComposing) {
  return key === 'Enter' && !shiftKey && !isComposing;
}
