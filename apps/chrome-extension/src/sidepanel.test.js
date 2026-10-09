import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatDraftKey } from './chat-drafts.js';

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const event = () => {
  const listeners = [];
  return { addListener: (listener) => listeners.push(listener), fire: (...args) => listeners.forEach((listener) => listener(...args)) };
};
function context(url) {
  const path = new URL(url).pathname.split('/');
  const kind = path[3] === 'issues' ? 'issue' : 'pullRequest';
  const id = `${path[1]}/${path[2]}#${path[4]}`;
  return kind === 'issue'
    ? { kind, id, issue: { title: id, remote_state: 'OPEN' }, messages: [] }
    : { kind, id, review: { id, title: id }, messages: [] };
}

async function panel(data = {}, reviewDetails = {}) {
  vi.resetModules();
  const nodes = { '.error': { textContent: '' }, '.pr-key': {}, '.dashboard': {} };
  const document = {
    hidden: false, activeElement: null, documentElement: { dataset: {}, style: {} },
    querySelector: (selector) => nodes[selector] || null,
    querySelectorAll: (selector) => selector === '[data-review-tab]' ? nodes.tabs || []
      : selector === 'details[data-finding-detail]' ? nodes.details || [] : [],
  };
  nodes.main = { set innerHTML(html) {
    this.markup = html;
    (nodes.details || []).forEach((detail) => { detail.isConnected = false; });
    nodes.details = [...html.matchAll(/<details\s+([^>]+)>/g)].flatMap((match) => {
      const key = match[1].match(/data-finding-detail="([^"]+)"/);
      return key ? [{
        dataset: { findingDetail: key[1] }, open: /\sopen(?:\s|$)/.test(match[1]),
        isConnected: true, listeners: {},
        addEventListener(name, callback) { this.listeners[name] = callback; },
      }] : [];
    });
    nodes.tabs = [...html.matchAll(/data-review-tab="([^"]+)"/g)].map((match) => ({
      dataset: { reviewTab: match[1] }, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
    }));
    nodes['.error'] = { textContent: '' };
    nodes.textarea = null;
    if (!html.includes('<textarea')) return;
    const input = {
      value: '', dataset: {}, selectionStart: 0, selectionEnd: 0, selectionDirection: 'none', scrollTop: 0,
      listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; },
      focus() { document.activeElement = this; },
      setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
    };
    nodes.textarea = input;
  } };
  let url = 'https://github.com/owner/repo/pull/1';
  const chrome = {
    tabs: { query: vi.fn(async () => [{ id: 1, url }]), onActivated: event(), onUpdated: event() },
    storage: { local: {
      get: vi.fn(async (key) => ({ [key]: data[key] })),
      set: vi.fn(async (values) => Object.assign(data, values)),
      remove: vi.fn(async (key) => { delete data[key]; }),
    }, onChanged: event() },
    runtime: { onMessage: event(), sendMessage: vi.fn(async (message) => {
      if (message.type !== 'barbarian-api') return null;
      if (message.path.includes('/chat')) return { ok: true, body: { message: { content: 'answer' } } };
      return { ok: true, body: { ...context(new URL(`http://localhost${message.path}`).searchParams.get('url')), ...reviewDetails } };
    }) },
  };
  vi.stubGlobal('chrome', chrome);
  vi.stubGlobal('document', document);
  vi.stubGlobal('setInterval', vi.fn());
  await import('./sidepanel.js');
  await settle();
  return {
    chrome, nodes, document, data,
    input: () => nodes.textarea,
    async type(value) { nodes.textarea.value = value; nodes.textarea.listeners.input(); await settle(); },
    async navigate(next) { url = next; chrome.tabs.onActivated.fire(); await settle(); },
    async update() {
      const next = context(url);
      chrome.runtime.onMessage.fire({ type: 'barbarian-context-updated', key: next.id, kind: next.kind, context: { ...next, ...reviewDetails } });
      await settle();
    },
    async send() { nodes.textarea.listeners.keydown({ key: 'Enter', preventDefault() {} }); await settle(); },
    async selectTab(name) { nodes.tabs.find((tab) => tab.dataset.reviewTab === name).listeners.click(); await settle(); },
    detail: (key) => nodes.details.find((detail) => detail.dataset.findingDetail === key),
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('side panel chat drafts', () => {
  it('renders embedded HTML in the PR overview without leaking into the panel', async () => {
    const p = await panel({}, { review: {
      id: 'owner/repo#1', title: 'Update oxfmt',
      simple_summary: 'Bumps oxfmt. <details><summary>Release notes</summary><h2>oxfmt v0.72.0</h2><ul><li>Format <code>parser:markdown</code> files</li></ul></details></section><script>alert(1)</script>',
    } });
    expect(p.nodes.main.markup).toContain('<details><summary>Release notes</summary><h2>oxfmt v0.72.0</h2>');
    expect(p.nodes.main.markup).toContain('<li>Format <code>parser:markdown</code> files</li>');
    expect(p.nodes.main.markup).toContain('&lt;/section&gt;&lt;script&gt;alert(1)&lt;/script&gt;</div>');
    expect(p.nodes.main.markup).toContain('AI Review Rounds:');
  });

  it('preserves collapsed findings and rounds through refreshes, tab switches, and reopening', async () => {
    const reviewDetails = {
      rounds: [{ id: 1, status: 'complete', findings: 1, provider: 'codex', comments: [{ summary: 'Round finding', body: 'Details' }] }],
      findings: [{ id: 'comment:1', summary: 'PR finding', body: 'Details', resolved: false }],
    };
    const p = await panel({}, reviewDetails);
    await p.selectTab('findings');
    const keys = ['round:1', 'round:1:finding:0', 'finding:comment:1'];
    keys.forEach((key) => {
      expect(p.detail(key).open).toBe(true);
      p.detail(key).open = false;
    });
    // Refresh can arrive before the browser dispatches its asynchronous toggle event.
    await p.update();
    keys.forEach((key) => expect(p.detail(key).open).toBe(false));
    await p.selectTab('review-room');
    await p.selectTab('findings');
    keys.forEach((key) => expect(p.detail(key).open).toBe(false));
    await p.navigate('https://github.com/owner/repo/pull/2');
    await p.selectTab('findings');
    keys.forEach((key) => expect(p.detail(key).open).toBe(true));
    const reopened = await panel(p.data, reviewDetails);
    await reopened.selectTab('findings');
    keys.forEach((key) => expect(reopened.detail(key).open).toBe(false));
  });

  it('keeps an explicitly expanded older round open when a newer round arrives', async () => {
    const reviewDetails = { rounds: [
      { id: 2, status: 'complete', findings: 0, comments: [] },
      { id: 1, status: 'complete', findings: 0, comments: [] },
    ] };
    const p = await panel({}, reviewDetails);
    await p.selectTab('findings');
    expect(p.detail('round:1').open).toBe(false);
    p.detail('round:1').open = true;
    p.detail('round:1').listeners.toggle();
    reviewDetails.rounds.unshift({ id: 3, status: 'complete', findings: 0, comments: [] });
    await p.update();
    expect(p.detail('round:1').open).toBe(true);
    expect(p.detail('round:3').open).toBe(true);
  });

  it('shows review rounds and full findings in their own tab without losing the chat draft', async () => {
    const p = await panel({}, {
      rounds: [{ id: 1, status: 'complete', findings: 0, provider: 'codex', summary: 'Round result', comments: [] }],
      findings: [{ id: 1, summary: 'Finding title', body: 'Full finding details', author: 'Reviewer', url: 'https://github.com/owner/repo/pull/1', resolved: false }],
    });
    expect(p.nodes.tabs.map((tab) => tab.dataset.reviewTab)).toEqual(['findings', 'review-room', 'timeline']);
    expect(p.nodes.main.markup).not.toContain('Full finding details');
    await p.type('unfinished question');
    await p.selectTab('findings');
    expect(p.input()).toBeNull();
    expect(p.nodes.main.markup).toContain('aria-label="Findings"');
    expect(p.nodes.main.markup).toContain('Round 1 · No issues found');
    expect(p.nodes.main.markup).toContain('Round result');
    expect(p.nodes.main.markup).toContain('Full finding details');
    expect(p.nodes.main.markup).toContain('Hide resolved');
    await p.selectTab('timeline');
    expect(p.nodes.main.markup).not.toContain('Full finding details');
    await p.selectTab('review-room');
    expect(p.input().value).toBe('unfinished question');
  });

  it('keeps text, focus, and selection through background refreshes for PRs and issues', async () => {
    const p = await panel();
    for (const url of ['https://github.com/owner/repo/pull/1', 'https://github.com/owner/repo/issues/2']) {
      await p.navigate(url);
      await p.type('unfinished\nquestion');
      const old = p.input();
      old.focus();
      old.setSelectionRange(3, 7, 'backward');
      old.scrollTop = 20;
      await p.update();
      expect(p.input()).not.toBe(old);
      expect(p.input().value).toBe('unfinished\nquestion');
      expect(p.document.activeElement).toBe(p.input());
      expect([p.input().selectionStart, p.input().selectionEnd, p.input().selectionDirection, p.input().scrollTop]).toEqual([3, 7, 'backward', 20]);
    }
  });

  it('isolates drafts across tab switches, unrelated pages, and panel recreation', async () => {
    const p = await panel();
    await p.type('PR draft');
    await p.navigate('https://github.com/owner/repo/issues/2');
    expect(p.input().value).toBe('');
    await p.type('issue draft');
    await p.navigate('https://example.com');
    expect(p.input()).toBeNull();
    await p.navigate('https://github.com/owner/repo/pull/1');
    expect(p.input().value).toBe('PR draft');
    const reopened = await panel(p.data);
    expect(reopened.input().value).toBe('PR draft');
    await reopened.navigate('https://github.com/owner/repo/issues/2');
    expect(reopened.input().value).toBe('issue draft');
  });

  it.each(['pull/1', 'issues/2'])('clears %s immediately and stays clear through refreshes while waiting', async (page) => {
    const p = await panel();
    await p.navigate(`https://github.com/owner/repo/${page}`);
    await p.type('question');
    const key = p.input().dataset.draftKey;
    let finish;
    p.chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await p.send();
    expect(p.input().value).toBe('');
    expect(p.data[key]).toBeUndefined();
    await p.update();
    expect(p.input().value).toBe('');
    finish({ ok: true, body: {} });
    await settle();
    expect(p.input().value).toBe('');
  });

  it('restores a failed message for retry', async () => {
    const p = await panel();
    await p.type('please keep this');
    p.chrome.runtime.sendMessage.mockResolvedValueOnce({ ok: false, error: 'Connection lost' });
    await p.send();
    expect(p.input().value).toBe('please keep this');
    expect(p.nodes['.error'].textContent).toBe('Connection lost');
    await p.send();
    expect(p.input().value).toBe('');
    expect(p.data[chatDraftKey('pullRequest', 'owner/repo#1')]).toBeUndefined();
  });

  it('does not clear new typing when an earlier message finishes sending', async () => {
    const p = await panel();
    await p.type('first question');
    let finish;
    p.chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await p.send();
    await p.type('next question');
    await p.update();
    finish({ ok: true, body: {} });
    await settle();
    expect(p.input().value).toBe('next question');
    expect(p.data[chatDraftKey('pullRequest', 'owner/repo#1')]).toBe('next question');
  });

  it('does not overwrite new typing when an earlier submission fails', async () => {
    const p = await panel();
    await p.type('first question');
    let finish;
    p.chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await p.send();
    expect(p.input().value).toBe('');
    await p.type('next question');
    await p.update();
    finish({ ok: false, error: 'Connection lost' });
    await settle();
    expect(p.input().value).toBe('next question');
    expect(p.data[chatDraftKey('pullRequest', 'owner/repo#1')]).toBe('next question');
    expect(p.nodes['.error'].textContent).toBe('Connection lost');
  });

  it('ignores an old context response after navigating to a different conversation', async () => {
    const p = await panel();
    await p.type('PR draft');
    let finish;
    const original = p.chrome.runtime.sendMessage.getMockImplementation();
    p.chrome.runtime.sendMessage.mockImplementation((message) => {
      if (message.type === 'barbarian-api' && message.path.includes('issue-context')) return new Promise((resolve) => { finish = resolve; });
      return original(message);
    });
    await p.navigate('https://github.com/owner/repo/issues/2');
    await p.navigate('https://github.com/owner/repo/pull/1');
    finish({ ok: true, body: context('https://github.com/owner/repo/issues/2') });
    await settle();
    expect(p.input().dataset.draftKey).toBe(chatDraftKey('pullRequest', 'owner/repo#1'));
    expect(p.input().value).toBe('PR draft');
  });

  it('restores the destination draft when a tab switch happens during a send', async () => {
    const issueKey = chatDraftKey('issue', 'owner/repo#2');
    const p = await panel({ [issueKey]: 'saved issue draft' });
    await p.type('PR question');
    let finish;
    p.chrome.runtime.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await p.send();
    await p.navigate('https://github.com/owner/repo/issues/2');
    finish({ ok: true, body: {} });
    await settle();
    expect(p.input().dataset.draftKey).toBe(issueKey);
    expect(p.input().value).toBe('saved issue draft');
    await p.navigate('https://github.com/owner/repo/pull/1');
    expect(p.input().value).toBe('');
  });
});
