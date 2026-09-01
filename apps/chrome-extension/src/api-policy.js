export function githubPullRequestKey(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com') return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
  } catch {
    return null;
  }
}

export function isAllowedApiMessage(message, senderUrl) {
  const senderKey = githubPullRequestKey(senderUrl);
  if (!senderKey || message?.type !== 'barbarian-api' || typeof message.path !== 'string') return false;

  const method = String(message.options?.method || 'GET').toUpperCase();
  let target;
  try { target = new URL(message.path, 'http://barbarian.local'); }
  catch { return false; }
  if (target.origin !== 'http://barbarian.local') return false;

  if (method === 'GET' && target.pathname === '/api/browser/context') {
    return githubPullRequestKey(target.searchParams.get('url') || '') === senderKey;
  }
  const actionMatch = target.pathname.match(/^\/api\/reviews\/([^/]+)\/(chat|run-review|workspace)$/);
  if (!actionMatch?.[1] || !actionMatch[2]) return false;
  const allowedMethod = method === 'POST' || method === 'DELETE' && actionMatch[2] === 'run-review';
  if (!allowedMethod) return false;
  try { return decodeURIComponent(actionMatch[1]) === `github:${senderKey}`; }
  catch { return false; }
}
