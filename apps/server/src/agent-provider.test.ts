import { describe, expect, it } from 'vitest';
import { agentInvocationArgs, agentProviderCapabilities } from './agent-provider.js';

describe('agent provider options', () => {
  it('applies Codex model and effort before the stdin prompt', () => {
    expect(agentInvocationArgs({
      command: '/usr/local/bin/codex',
      args: ['exec', '--model', 'old-model', '--sandbox', 'read-only', '-'],
      model: 'gpt-review',
      effort: 'xhigh',
    })).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-review',
      '-c', 'model_reasoning_effort="xhigh"', '-',
    ]);
  });

  it('can grant a Codex branch-room invocation workspace write access', () => {
    expect(agentInvocationArgs({
      command: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
    }, { codexSandbox: 'workspace-write' })).toEqual([
      'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-',
    ]);
  });

  it('applies Claude model and effort flags', () => {
    expect(agentInvocationArgs({
      command: 'claude', args: ['-p', '--effort=low'], model: 'opus', effort: 'high',
    })).toEqual(['-p', '--model', 'opus', '--effort', 'high']);
  });

  it('applies a Gemini model and reports that effort is unavailable', () => {
    expect(agentInvocationArgs({ command: 'gemini', args: [], model: 'gemini-review' }))
      .toEqual(['--model', 'gemini-review']);
    expect(agentProviderCapabilities('gemini')).toEqual({ model: true, effort: false });
  });

  it('applies a Cursor model and reports that effort is encoded by its model ID', () => {
    expect(agentInvocationArgs({
      command: 'cursor-agent', args: ['-p', '--mode', 'ask', '--output-format', 'text'],
      model: 'cursor-grok-4.6-high',
    })).toEqual([
      '-p', '--mode', 'ask', '--output-format', 'text', '--model', 'cursor-grok-4.6-high',
    ]);
    expect(agentProviderCapabilities('/Users/developer/.local/bin/cursor-agent'))
      .toEqual({ model: true, effort: false });
  });

  it('does not invent flags for a custom command', () => {
    expect(agentInvocationArgs({ command: 'custom-reviewer', args: ['review'], model: 'metadata-only' }))
      .toEqual(['review']);
    expect(agentProviderCapabilities('custom-reviewer')).toEqual({ model: false, effort: false });
  });
});
