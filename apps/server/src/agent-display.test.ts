import { describe, expect, it } from 'vitest';
import type { BarbarianConfig } from './types.js';
import { configuredAgentModel } from './agent-display.js';

function config(provider: BarbarianConfig['agents']['providers'][string]): BarbarianConfig {
  return {
    version: 1,
    profile: { name: 'Chris', timezone: 'UTC', githubLogin: 'cb1kenobi' },
    appearance: { theme: 'dark', fontSize: 'normal' },
    monitor: { intervalMinutes: 20, runOnStartup: true, includeDraftPullRequests: false },
    repositories: [],
    review: { requestedReviewer: 'cb1kenobi', fallbackTeams: [], workspaceRoot: '', autoCleanup: true },
    linear: { enabled: false, command: [] },
    agents: {
      default: 'codex', autoReview: true, maxConcurrent: 2, maxAutomaticAttempts: 3,
      retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3, providers: { codex: provider },
    },
    statusUpdate: { enabled: false, workdays: [], daysOff: [] },
  };
}

describe('configuredAgentModel', () => {
  it('prefers explicit display metadata', () => {
    expect(configuredAgentModel(config({ command: 'codex', args: ['--model', 'from-args'], model: 'gpt-5.6' }), 'codex'))
      .toBe('gpt-5.6');
  });

  it('reads common CLI model arguments', () => {
    expect(configuredAgentModel(config({ command: 'codex', args: ['exec', '--model=sonnet'] }), 'codex')).toBe('sonnet');
    expect(configuredAgentModel(config({ command: 'codex', args: ['exec', '-m', 'gpt-5'] }), 'codex')).toBe('gpt-5');
  });

  it('labels an unspecified model honestly', () => {
    expect(configuredAgentModel(config({ command: 'codex', args: ['exec'] }), 'codex')).toBe('CLI default');
  });
});
