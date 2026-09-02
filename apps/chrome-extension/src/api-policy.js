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

export function githubIssueKey(value) {
  try {
    const url = new URL(value);
    if (url.origin !== 'https://github.com') return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/);
    return match ? `${match[1]}/${match[2]}#${match[3]}` : null;
  } catch {
    return null;
  }
}

export function githubPageContext(value) {
  const pullRequest = githubPullRequestKey(value);
  if (pullRequest) return { kind: 'pullRequest', key: pullRequest };
  const issue = githubIssueKey(value);
  return issue ? { kind: 'issue', key: issue } : null;
}

export function isAllowedApiMessage(message, senderUrl) {
  const senderContext = githubPageContext(senderUrl);
  if (!senderContext || message?.type !== 'barbarian-api' || typeof message.path !== 'string') return false;

  const method = String(message.options?.method || 'GET').toUpperCase();
  let target;
  try { target = new URL(message.path, 'http://barbarian.local'); }
  catch { return false; }
  if (target.origin !== 'http://barbarian.local') return false;

  if (method === 'GET' && target.pathname === '/api/browser/context') {
    return senderContext.kind === 'pullRequest'
      && githubPullRequestKey(target.searchParams.get('url') || '') === senderContext.key;
  }
  if (method === 'GET' && target.pathname === '/api/browser/issue-context') {
    return senderContext.kind === 'issue'
      && githubIssueKey(target.searchParams.get('url') || '') === senderContext.key;
  }
  const issueChat = target.pathname.match(/^\/api\/issues\/([^/]+)\/chat$/);
  if (issueChat?.[1]) {
    if (method !== 'POST' || senderContext.kind !== 'issue') return false;
    try { return decodeURIComponent(issueChat[1]) === `github:${senderContext.key}`; }
    catch { return false; }
  }
  const actionMatch = target.pathname.match(/^\/api\/reviews\/([^/]+)\/(chat|run-review|workspace)$/);
  if (!actionMatch?.[1] || !actionMatch[2]) return false;
  const allowedMethod = method === 'POST' || method === 'DELETE' && actionMatch[2] === 'run-review';
  if (!allowedMethod) return false;
  if (senderContext.kind !== 'pullRequest') return false;
  try { return decodeURIComponent(actionMatch[1]) === `github:${senderContext.key}`; }
  catch { return false; }
}
