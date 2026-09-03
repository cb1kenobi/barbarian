import { describe, expect, it } from 'vitest';
import { configuredAgentForTask, enabledCodeReviewProviders } from './agent-config.js';
import type { BarbarianConfig } from './types.js';

const config = {
  agents: {
    codeReview: {
      codex: { enabled: true, model: 'gpt-review', effort: 'high' },
      gemini: { enabled: true, model: 'gemini-pro', effort: '' },
      claude: { enabled: false, model: 'opus', effort: 'medium' },
    },
    chat: { provider: 'claude', model: 'sonnet', effort: 'medium' },
    providers: {
      codex: { command: 'codex', args: ['exec', '-'] },
      claude: { command: 'claude', args: ['-p'] },
      gemini: { command: 'gemini', args: [] },
    },
  },
} as unknown as BarbarianConfig;

describe('task-specific agent configuration', () => {
  it('uses the review selection for PR and local branch reviews', () => {
    expect(configuredAgentForTask(config, 'code_review:new_pr')).toMatchObject({
      name: 'codex', provider: { model: 'gpt-review', effort: 'high' },
    });
    expect(configuredAgentForTask(config, 'local_branch_review')).toMatchObject({
      name: 'codex', provider: { model: 'gpt-review', effort: 'high' },
    });
  });

  it('lists every enabled code review provider in provider order', () => {
    expect(enabledCodeReviewProviders(config)).toEqual(['codex', 'gemini']);
  });

  it('uses the chat selection for every conversation task', () => {
    for (const task of ['chat', 'issue_chat', 'local_branch_chat']) {
      expect(configuredAgentForTask(config, task)).toMatchObject({
        name: 'claude', provider: { model: 'sonnet', effort: 'medium' },
      });
    }
  });

  it('keeps explicit provider overrides but does not borrow another provider selection', () => {
    expect(configuredAgentForTask(config, 'chat', 'gemini')).toEqual({
      name: 'gemini', provider: { command: 'gemini', args: [] },
    });
  });
});
