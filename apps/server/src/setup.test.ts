import { describe, expect, it } from 'vitest';
import { applySetupAnswers, collectSetupAnswers, detectInstalledAgents, formatNextSteps } from './setup.js';
import { parseConfig } from './config.js';

const config = parseConfig({
  version: 1,
  server: { bindAddress: '127.0.0.1', port: 4142, trustedHosts: [] },
  desktop: { launchAtLogin: false, globalShortcut: 'CommandOrControl+Shift+Space' },
  profile: { name: 'Developer', timezone: 'America/Chicago', githubLogin: 'old-login' },
  monitor: { intervalMinutes: 20, runOnStartup: true },
  repositories: [],
  review: { requestedReviewer: 'old-login', fallbackTeams: [], workspaceRoot: '.barbarian/workspaces', autoCleanup: true },
  linear: { enabled: false, command: [] },
  agents: {
    default: 'codex', autoReview: false, maxConcurrent: 2, maxAutomaticAttempts: 3,
    codeReview: { codex: { enabled: true, model: '', effort: '' } },
    chat: { provider: 'codex', model: '', effort: '' },
    retryBaseMinutes: 5, maxRunsPerPullRequestPerHour: 3,
    providers: {
      codex: { command: 'codex', args: [] },
      claude: { command: 'claude', args: [] },
      gemini: { command: 'gemini', args: [] },
      cursor: { command: 'cursor-agent', args: [] },
    },
  },
  statusUpdate: { enabled: true, workdays: ['monday'], daysOff: [] },
});

describe('configuration setup', () => {
  it('detects supported CLIs while preserving their provider names', async () => {
    const installed = new Set(['codex', 'cursor-agent']);
    const detected = await detectInstalledAgents(async (command) => installed.has(command) ? `/bin/${command}` : null);
    expect(detected).toEqual([
      { name: 'codex', command: 'codex', executable: '/bin/codex' },
      { name: 'cursor', command: 'cursor-agent', executable: '/bin/cursor-agent' },
    ]);
  });

  it('collects basic information and accepts a numbered agent choice', async () => {
    const responses = ['Chris Barber', 'cb1kenobi', 'no', '2', 'yes', 'no'];
    const messages: string[] = [];
    const answers = await collectSetupAnswers(
      config,
      [
        { name: 'codex', command: 'codex', executable: '/bin/codex' },
        { name: 'cursor', command: 'cursor-agent', executable: '/bin/cursor-agent' },
      ],
      async () => responses.shift()!,
      (message) => messages.push(message),
    );
    expect(answers).toEqual({
      name: 'Chris Barber', githubLogin: 'cb1kenobi', runOnStartup: false, defaultAgent: 'cursor',
      installEditorExtension: true, installChromeExtension: false,
    });
    expect(messages.join('')).toContain('cursor (cursor-agent)');
  });

  it('uses current values on blank answers and falls back to an installed default', async () => {
    const responses = ['', '', '', '', '', ''];
    const answers = await collectSetupAnswers(
      { ...config, agents: { ...config.agents, codeReview: {
        ...config.agents.codeReview,
        codex: { ...config.agents.codeReview.codex!, enabled: false },
        gemini: { enabled: true, model: '', effort: '' },
      } } },
      [{ name: 'claude', command: 'claude', executable: '/bin/claude' }],
      async () => responses.shift()!,
    );
    expect(answers).toEqual({
      name: 'Developer', githubLogin: 'old-login', runOnStartup: true, defaultAgent: 'claude',
      installEditorExtension: false, installChromeExtension: false,
    });
  });

  it('updates the identity, reviewer, startup sync, and default agent without changing provider commands', () => {
    const updated = applySetupAnswers(config, {
      name: 'Chris Barber', githubLogin: 'cb1kenobi', runOnStartup: false, defaultAgent: 'cursor',
      installEditorExtension: true, installChromeExtension: true,
    });
    expect(updated.profile).toMatchObject({ name: 'Chris Barber', githubLogin: 'cb1kenobi' });
    expect(updated.review.requestedReviewer).toBe('cb1kenobi');
    expect(updated.monitor.runOnStartup).toBe(false);
    expect(updated.agents.codeReview.cursor?.enabled).toBe(true);
    expect(updated.agents.codeReview.codex?.enabled).toBe(false);
    expect(updated.agents.chat.provider).toBe('cursor');
    expect(updated.agents.providers).toEqual(config.agents.providers);
  });

  it('formats selected extension guidance as numbered next steps', () => {
    const output = formatNextSteps({
      name: 'Chris Barber', githubLogin: 'cb1kenobi', runOnStartup: true, defaultAgent: 'cursor',
      installEditorExtension: true, installChromeExtension: true,
    }, '/projects/barbarian');
    expect(output).toContain('NEXT STEPS');
    expect(output).toContain('1. Start the Barbarian server:');
    expect(output).toContain('2. Open the dashboard:');
    expect(output).toContain('3. Finish editor extension setup:');
    expect(output).toContain('4. Load the Chrome extension:');
    expect(output).toContain('/projects/barbarian/apps/chrome-extension');
    expect(output).toContain('Startup sync is enabled');
    expect(output).not.toContain('\u001B[');
  });
});
