import { describe, expect, it } from 'vitest';
import { githubIssueKey, githubPageContext, githubPullRequestKey, isAllowedApiMessage } from './api-policy.js';

const senderUrl = 'https://github.com/HarperFast/harper/pull/2430/files';

describe('Chrome extension API policy', () => {
  it('recognizes GitHub pull request URLs', () => {
    expect(githubPullRequestKey(senderUrl)).toBe('HarperFast/harper#2430');
    expect(githubPullRequestKey('https://example.com/HarperFast/harper/pull/2430')).toBeNull();
  });

  it('recognizes GitHub issue URLs without confusing them with pull requests', () => {
    const issueUrl = 'https://github.com/HarperFast/rocksdb-js/issues/787';
    expect(githubIssueKey(issueUrl)).toBe('HarperFast/rocksdb-js#787');
    expect(githubPullRequestKey(issueUrl)).toBeNull();
    expect(githubPageContext(issueUrl)).toEqual({ kind: 'issue', key: 'HarperFast/rocksdb-js#787' });
  });

  it('allows context lookup only for the sender pull request', () => {
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: `/api/browser/context?url=${encodeURIComponent(senderUrl)}`,
    }, senderUrl)).toBe(true);
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: '/api/browser/context?url=https%3A%2F%2Fgithub.com%2FHarperFast%2Fharper%2Fpull%2F9999',
    }, senderUrl)).toBe(false);
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: `/api/browser/context?url=${encodeURIComponent(senderUrl)}&refresh=1`,
    }, senderUrl)).toBe(true);
  });

  it('allows same-PR review actions but rejects unrelated local API access', () => {
    for (const action of ['chat', 'run-review', 'workspace', 'track']) {
      expect(isAllowedApiMessage({
        type: 'barbarian-api',
        path: `/api/reviews/github%3AHarperFast%2Fharper%232430/${action}`,
        options: { method: 'POST', body: '{}' },
      }, senderUrl)).toBe(true);
    }
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: '/api/reviews/github%3AHarperFast%2Fharper%232430/run-review',
      options: { method: 'DELETE' },
    }, senderUrl)).toBe(true);
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: '/api/reviews/github%3AHarperFast%2Fharper%232430/workspace',
      options: { method: 'DELETE' },
    }, senderUrl)).toBe(false);
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: '/api/reviews/github%3AHarperFast%2Fharper%239999/chat',
      options: { method: 'POST', body: '{}' },
    }, senderUrl)).toBe(false);
    expect(isAllowedApiMessage({ type: 'barbarian-api', path: '/api/dashboard' }, senderUrl)).toBe(false);
  });

  it('allows only the matching issue context and Issue Room chat', () => {
    const issueUrl = 'https://github.com/HarperFast/rocksdb-js/issues/787';
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: `/api/browser/issue-context?url=${encodeURIComponent(issueUrl)}&refresh=1`,
    }, issueUrl)).toBe(true);
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: '/api/issues/github%3AHarperFast%2Frocksdb-js%23787/chat',
      options: { method: 'POST', body: '{}' },
    }, issueUrl)).toBe(true);
    expect(isAllowedApiMessage({
      type: 'barbarian-api',
      path: '/api/reviews/github%3AHarperFast%2Frocksdb-js%23787/run-review',
      options: { method: 'POST', body: '{}' },
    }, issueUrl)).toBe(false);
  });
});
