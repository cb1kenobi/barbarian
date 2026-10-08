import { describe, expect, it, vi } from 'vitest';
import { createFindingExpansion } from './finding-expansion.js';

function memoryStorage() {
  const data = {};
  return {
    get: vi.fn(async (key) => ({ [key]: data[key] })),
    set: vi.fn(async (values) => Object.assign(data, values)),
  };
}

describe('finding expansion preferences', () => {
  it('persists explicit choices per PR while retaining defaults for new findings', async () => {
    const storage = memoryStorage();
    const state = createFindingExpansion(storage);
    await state.load('Owner/Repo#1');
    await state.remember('Owner/Repo#1', 'finding:1', false);
    await state.remember('Owner/Repo#1', 'round:2', true);
    const reopened = createFindingExpansion(storage);
    await reopened.load('owner/repo#1');
    expect(reopened.isOpen('owner/repo#1', 'finding:1', true)).toBe(false);
    expect(reopened.isOpen('owner/repo#1', 'round:2', false)).toBe(true);
    expect(reopened.isOpen('owner/repo#1', 'finding:3', true)).toBe(true);
    expect(reopened.isOpen('owner/repo#2', 'finding:1', true)).toBe(true);
  });

  it('keeps user toggles made while loading and ignores malformed stored preferences', async () => {
    const storage = memoryStorage();
    let resolve;
    storage.get.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const state = createFindingExpansion(storage);
    const loading = state.load('owner/repo#1');
    await state.remember('owner/repo#1', 'finding:1', false);
    resolve({ 'barbarian.findingExpansion:owner/repo#1': { 'finding:1': true, 'finding:2': 'bad', 'round:1': false } });
    await loading;
    expect(state.isOpen('owner/repo#1', 'finding:1', true)).toBe(false);
    expect(state.isOpen('owner/repo#1', 'finding:2', true)).toBe(true);
    expect(state.isOpen('owner/repo#1', 'round:1', true)).toBe(false);
  });

  it('serializes saves and keeps the most recent toggle after a failed save', async () => {
    const storage = memoryStorage();
    storage.set.mockRejectedValueOnce(new Error('Unavailable'));
    const state = createFindingExpansion(storage);
    await state.load('owner/repo#1');
    const first = state.remember('owner/repo#1', 'finding:1', false);
    const second = state.remember('owner/repo#1', 'finding:1', true);
    await Promise.all([first, second]);
    const reopened = createFindingExpansion(storage);
    await reopened.load('owner/repo#1');
    expect(reopened.isOpen('owner/repo#1', 'finding:1', false)).toBe(true);
  });
});
