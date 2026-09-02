import { resolveExecutable } from './process.js';
import { parseConfig } from './config.js';
import type { BarbarianConfig } from './types.js';

export interface DetectedAgent {
  name: string;
  command: string;
  executable: string;
}

export interface SetupAnswers {
  name: string;
  githubLogin: string;
  runOnStartup: boolean;
  defaultAgent: string;
  installEditorExtension: boolean;
  installChromeExtension: boolean;
}

export type Ask = (prompt: string) => Promise<string>;
export type Write = (message: string) => void;

const supportedAgents = [
  { name: 'codex', command: 'codex' },
  { name: 'claude', command: 'claude' },
  { name: 'gemini', command: 'gemini' },
  { name: 'cursor', command: 'cursor-agent' },
] as const;

export async function detectInstalledAgents(
  resolve: (command: string) => Promise<string | null> = resolveExecutable,
): Promise<DetectedAgent[]> {
  const detected = await Promise.all(supportedAgents.map(async ({ name, command }) => {
    const executable = await resolve(command);
    return executable ? { name, command, executable } : null;
  }));
  return detected.filter((agent) => agent !== null);
}

async function askBoolean(ask: Ask, prompt: string, current: boolean): Promise<boolean> {
  while (true) {
    const answer = (await ask(`${prompt} [${current ? 'Y/n' : 'y/N'}]: `)).trim().toLowerCase();
    if (!answer) return current;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
  }
}

async function askDefaultAgent(
  ask: Ask,
  write: Write,
  installed: DetectedAgent[],
  current: string,
): Promise<string> {
  if (installed.length === 0) {
    write(`No supported AI agent CLIs detected; keeping ${current} as the default.\n`);
    return current;
  }

  write('Detected AI agents:\n');
  installed.forEach((agent, index) => write(`  ${index + 1}. ${agent.name} (${agent.command})\n`));
  const fallback = installed.some((agent) => agent.name === current) ? current : installed[0]!.name;

  while (true) {
    const answer = (await ask(`Default agent [${fallback}]: `)).trim().toLowerCase();
    if (!answer) return fallback;
    const numericChoice = Number(answer);
    if (Number.isInteger(numericChoice) && numericChoice >= 1 && numericChoice <= installed.length) {
      return installed[numericChoice - 1]!.name;
    }
    const namedChoice = installed.find((agent) => agent.name === answer);
    if (namedChoice) return namedChoice.name;
    write(`Choose 1-${installed.length} or enter an agent name shown above.\n`);
  }
}

export async function collectSetupAnswers(
  current: BarbarianConfig,
  installed: DetectedAgent[],
  ask: Ask,
  write: Write = () => undefined,
): Promise<SetupAnswers> {
  const name = (await ask(`Your name [${current.profile.name}]: `)).trim() || current.profile.name;
  const githubLogin = (await ask(`GitHub username${current.profile.githubLogin ? ` [${current.profile.githubLogin}]` : ''}: `)).trim()
    || current.profile.githubLogin;
  const runOnStartup = await askBoolean(ask, 'Sync when Barbarian starts?', current.monitor.runOnStartup);
  const defaultAgent = await askDefaultAgent(ask, write, installed, current.agents.default);
  const installEditorExtension = await askBoolean(ask, 'Build and install the Cursor/VS Code extension?', false);
  const installChromeExtension = await askBoolean(ask, 'Set up the Chrome extension?', false);
  return { name, githubLogin, runOnStartup, defaultAgent, installEditorExtension, installChromeExtension };
}

export function applySetupAnswers(current: BarbarianConfig, answers: SetupAnswers): BarbarianConfig {
  return parseConfig({
    ...current,
    profile: {
      ...current.profile,
      name: answers.name,
      githubLogin: answers.githubLogin,
    },
    monitor: {
      ...current.monitor,
      runOnStartup: answers.runOnStartup,
    },
    review: {
      ...current.review,
      requestedReviewer: answers.githubLogin,
    },
    agents: {
      ...current.agents,
      default: answers.defaultAgent,
    },
  });
}

export function formatNextSteps(answers: SetupAnswers, projectRoot: string, color = false): string {
  const style = (code: string, value: string) => color ? `\u001B[${code}m${value}\u001B[0m` : value;
  const heading = style('1;38;2;190;255;50', 'NEXT STEPS');
  const number = (value: number) => style('1;38;2;190;255;50', `${value}.`);
  const command = (value: string) => style('38;2;102;204;255', value);
  const lines = ['', '────────────────────────────────────────', heading, '────────────────────────────────────────'];
  let step = 1;

  lines.push('', `${number(step++)} Start the Barbarian server:`, `   ${command('pnpm dev')}`);
  lines.push(answers.runOnStartup
    ? '   Startup sync is enabled; Barbarian will sync as soon as the server is ready.'
    : `   Startup sync is disabled; run ${command('pnpm sync')} when you want the first refresh.`);
  lines.push('', `${number(step++)} Open the dashboard:`, `   ${command('http://127.0.0.1:4141')}`);

  if (answers.installEditorExtension) {
    lines.push('', `${number(step++)} Finish editor extension setup:`,
      '   Reload Cursor or VS Code to activate the extension.',
      '   If no editor CLI was detected, run “Extensions: Install from VSIX...” and select the packaged file shown above.');
  }

  if (answers.installChromeExtension) {
    lines.push('', `${number(step++)} Load the Chrome extension:`,
      `   Extension directory: ${command(`${projectRoot}/apps/chrome-extension`)}`,
      `   a. Open ${command('chrome://extensions')}`,
      '   b. Enable Developer mode',
      '   c. Click Load unpacked',
      '   d. Choose the extension directory above');
  }

  return `${lines.join('\n')}\n`;
}
