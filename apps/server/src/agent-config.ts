import type { AgentProviderConfig, AgentSelectionConfig, BarbarianConfig } from './types.js';

export function isCodeReviewTask(task: string): boolean {
  return task === 'local_branch_review' || task.startsWith('code_review:');
}

export function agentSelectionForTask(config: BarbarianConfig, task: string): AgentSelectionConfig {
  if (!isCodeReviewTask(task)) return config.agents.chat;
  const provider = enabledCodeReviewProviders(config)[0];
  if (!provider) throw new Error('No code review agents are enabled');
  const selection = config.agents.codeReview[provider]!;
  return { provider, model: selection.model, effort: selection.effort };
}

export function enabledCodeReviewProviders(config: BarbarianConfig): string[] {
  return Object.keys(config.agents.codeReview).filter((name) => config.agents.codeReview[name]?.enabled);
}

export function configuredAgentForTask(
  config: BarbarianConfig,
  task: string,
  requestedProvider?: string,
): { name: string; provider: AgentProviderConfig } {
  const selection = isCodeReviewTask(task) && requestedProvider
    ? { provider: requestedProvider, ...(config.agents.codeReview[requestedProvider] || { model: '', effort: '' }) }
    : agentSelectionForTask(config, task);
  const name = requestedProvider || selection.provider;
  const provider = config.agents.providers[name];
  if (!provider) throw new Error(`Agent provider "${name}" is not configured`);
  const useSelection = name === selection.provider;
  const model = useSelection ? selection.model.trim() || undefined : provider.model;
  const effort = useSelection ? selection.effort || undefined : provider.effort;
  return {
    name,
    provider: {
      ...provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    },
  };
}
