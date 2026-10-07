import { describe, expect, it, vi } from 'vitest';
import { chatDraftKey, createChatDrafts } from './chat-drafts.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    get: vi.fn(async (key) => ({ [key]: data[key] })),
    set: vi.fn(async (values) => Object.assign(data, values)),
    remove: vi.fn(async (key) => { delete data[key]; }),
  };
}

describe('saved chat drafts', () => {
  it('restores separate PR and issue drafts after the panel is recreated', async () => {
    const storage = memoryStorage();
    const drafts = createChatDrafts(storage);
    const pr = chatDraftKey('pullRequest', 'Owner/Repo#1');
    const issue = chatDraftKey('issue', 'Owner/Repo#1');
    await drafts.set(pr, '  unfinished PR question\n');
    await drafts.set(issue, 'issue question');
    const reopened = createChatDrafts(storage);
    expect((await reopened.load(chatDraftKey('pullRequest', 'owner/repo#1'))).value).toBe('  unfinished PR question\n');
    expect((await reopened.load(issue)).value).toBe('issue question');
    expect((await reopened.load(chatDraftKey('pullRequest', 'owner/repo#2'))).value).toBe('');
  });

  it('does not replace fresh typing with a delayed storage read', async () => {
    const storage = memoryStorage();
    let resolve;
    storage.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const drafts = createChatDrafts(storage);
    const loading = drafts.load('pr');
    await drafts.set('pr', 'new typing');
    resolve({ pr: 'old draft' });
    expect((await loading).value).toBe('new typing');
  });

  it('serializes storage writes so the last keystroke wins', async () => {
    const storage = memoryStorage();
    let resolve;
    storage.set.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const drafts = createChatDrafts(storage);
    const first = drafts.set('pr', 'a');
    const second = drafts.set('pr', 'ab');
    await Promise.resolve();
    expect(storage.set).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.all([first, second]);
    expect(storage.data.pr).toBe('ab');
  });

  it('clears a sent draft durably but preserves subsequent edits, even if reverted', async () => {
    const storage = memoryStorage();
    const drafts = createChatDrafts(storage);
    await drafts.set('pr', 'question');
    const sent = drafts.snapshot('pr');
    await drafts.set('pr', 'another question');
    await drafts.set('pr', 'question');
    expect(await drafts.clearIfUnchanged('pr', sent)).toBe(false);
    expect(storage.data.pr).toBe('question');
    expect(await drafts.clearIfUnchanged('pr', drafts.snapshot('pr'))).toBe(true);
    expect((await createChatDrafts(storage).load('pr')).value).toBe('');
  });

  it('keeps text in memory and retries the same draft after a failed save', async () => {
    const storage = memoryStorage();
    storage.set.mockRejectedValueOnce(new Error('storage unavailable'));
    const drafts = createChatDrafts(storage);
    expect(await drafts.set('pr', 'keep this')).toBe(false);
    expect(drafts.snapshot('pr').value).toBe('keep this');
    expect(await drafts.set('pr', 'keep this')).toBe(true);
    expect(storage.data.pr).toBe('keep this');
  });
});
