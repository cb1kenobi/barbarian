import type { BarbarianConfig } from './types.js';

export function configuredAgentModel(config: BarbarianConfig, providerName: string): string {
  const provider = config.agents.providers[providerName];
  if (!provider) return 'CLI default';
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

export function configuredAgentEffort(config: BarbarianConfig, providerName: string): string {
  return config.agents.providers[providerName]?.effort || 'CLI default';
}
