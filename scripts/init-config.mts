import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { ConfigStore, configPath, envPath, projectRoot, saveConfigUpdate } from '../apps/server/src/config.ts';
import { applySetupAnswers, collectSetupAnswers, detectInstalledAgents, formatNextSteps } from '../apps/server/src/setup.ts';

const store = await ConfigStore.load();

function runNodeScript(script: string, args: string[] = []): void {
  const result = spawnSync(process.execPath, [path.join(projectRoot, script), ...args], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status ?? 'unknown'}`);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.log(`Configuration files are ready:\n- ${configPath}\n- ${envPath}\nRun pnpm configure in an interactive terminal to use the setup wizard.`);
} else {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('\nBarbarian setup\n');
    const installed = await detectInstalledAgents();
    const answers = await collectSetupAnswers(
      store.get(),
      installed,
      (prompt) => input.question(prompt),
      (message) => process.stdout.write(message),
    );
    await saveConfigUpdate(applySetupAnswers(store.get(), answers), configPath, store.revision);
    console.log(`\nConfiguration saved:\n- ${configPath}\n- ${envPath}`);

    if (answers.installEditorExtension) {
      console.log('\nBuilding and packaging the Cursor/VS Code extension...');
      try {
        runNodeScript('scripts/install-vscode-extension.mjs', ['--detected']);
      } catch (error) {
        process.exitCode = 1;
        console.error(`Could not finish editor extension setup: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (answers.installChromeExtension) {
      try {
        runNodeScript('apps/chrome-extension/scripts/validate.mjs', ['--quiet']);
      } catch (error) {
        process.exitCode = 1;
        console.error(`Could not prepare the Chrome extension: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const useColor = process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
    process.stdout.write(formatNextSteps(answers, projectRoot, Boolean(useColor)));
  } finally {
    input.close();
  }
}
