import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverAgentModels } from './agent-models.js';

describe('agent model discovery', () => {
  const directories: string[] = [];
  const codexHome = () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-models-'));
    directories.push(directory);
    return directory;
  };

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('reads visible Codex models and flags the configured CLI default', async () => {
    const directory = codexHome();
    writeFileSync(path.join(directory, 'config.toml'), 'model = "gpt-default"\n[projects.test]\nmodel = "ignored"\n');
    writeFileSync(path.join(directory, 'models_cache.json'), JSON.stringify({ models: [
      { slug: 'hidden', display_name: 'Hidden', visibility: 'hide', priority: 0 },
      { slug: 'gpt-other', display_name: 'GPT Other', visibility: 'list', priority: 2 },
      { slug: 'gpt-default', display_name: 'GPT Default', visibility: 'list', priority: 1 },
    ] }));

    await expect(discoverAgentModels({ command: 'codex', args: ['exec', '-'] }, { codexHome: directory })).resolves.toEqual({
      defaultModel: 'gpt-default',
      models: [
        { id: 'gpt-default', name: 'GPT Default', isDefault: true },
        { id: 'gpt-other', name: 'GPT Other', isDefault: false },
      ],
    });
  });

  it('uses an invocation model as the default and retains it when it is absent from the cache', async () => {
    const directory = codexHome();
    writeFileSync(path.join(directory, 'models_cache.json'), JSON.stringify({ models: [] }));
    await expect(discoverAgentModels({ command: '/usr/local/bin/codex', args: ['exec', '--model=custom'] }, { codexHome: directory }))
      .resolves.toEqual({ defaultModel: 'custom', models: [{ id: 'custom', name: 'custom', isDefault: true }] });
  });

  it('parses Claude model aliases and its reported default', async () => {
    const result = JSON.stringify({
      is_error: false,
      result: 'Current model: Opus 5 (1M context) (default) (effort: high)\nUsage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.',
    });
    await expect(discoverAgentModels(
      { command: 'claude', args: ['-p'] },
      { runClaude: async () => result },
    )).resolves.toEqual({
      defaultModel: 'opus[1m]',
      models: [
        { id: 'sonnet', name: 'sonnet', isDefault: false },
        { id: 'opus', name: 'opus', isDefault: false },
        { id: 'haiku', name: 'haiku', isDefault: false },
        { id: 'fable', name: 'fable', isDefault: false },
        { id: 'best', name: 'best', isDefault: false },
        { id: 'sonnet[1m]', name: 'sonnet[1m]', isDefault: false },
        { id: 'opus[1m]', name: 'Opus 5 (1M context)', isDefault: true },
        { id: 'fable[1m]', name: 'fable[1m]', isDefault: false },
        { id: 'opusplan', name: 'opusplan', isDefault: false },
      ],
    });
  });

  it('returns no list when a provider cannot be queried', async () => {
    await expect(discoverAgentModels(
      { command: 'claude', args: ['-p'] },
      { runClaude: async () => { throw new Error('unavailable'); } },
    )).resolves.toEqual({ models: [], defaultModel: null });
    await expect(discoverAgentModels({ command: 'gemini', args: [] })).resolves.toEqual({ models: [], defaultModel: null });
  });
});
