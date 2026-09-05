import type { AgentSelectionConfig, BarbarianConfig } from './types.js';
import { configuredAgentForTask } from './agent-config.js';

export function configuredAgentModel(
  config: BarbarianConfig,
  providerName: string,
  task = 'chat',
  selection?: AgentSelectionConfig,
): string {
  let provider;
  try { provider = configuredAgentForTask(config, task, providerName, selection).provider; } catch { return 'CLI default'; }
  if (provider.model?.trim()) return provider.model.trim();
  for (let index = 0; index < provider.args.length; index += 1) {
    const argument = provider.args[index] || '';
    if ((argument === '--model' || argument === '-m') && provider.args[index + 1]) {
      return provider.args[index + 1]!;
    }
    if (argument.startsWith('--model=') && argument.slice('--model='.length)) {
      return argument.slice('--model='.length);
    }
  }
  return 'CLI default';
}

export function configuredAgentEffort(
  config: BarbarianConfig,
  providerName: string,
  task = 'chat',
  selection?: AgentSelectionConfig,
): string {
  try { return configuredAgentForTask(config, task, providerName, selection).provider.effort || 'CLI default'; } catch { return 'CLI default'; }
}
