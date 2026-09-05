import type { AgentProviderConfig, AgentSelectionConfig, BarbarianConfig, CodeReviewAgentConfig } from './types.js';

export function isCodeReviewTask(task: string): boolean {
  return task === 'local_branch_review' || task.startsWith('code_review:');
}

export function agentSelectionForTask(config: BarbarianConfig, task: string): AgentSelectionConfig {
  if (!isCodeReviewTask(task)) return config.agents.chat;
  const selection = config.agents.codeReview[0];
  if (!selection) throw new Error('No code review agents are configured');
  return { provider: selection.provider, model: selection.model, effort: selection.effort };
}

export function enabledCodeReviewProviders(config: BarbarianConfig): string[] {
  return config.agents.codeReview.map((agent) => agent.provider);
}

export function configuredAgentForTask(
  config: BarbarianConfig,
  task: string,
  requestedProvider?: string,
  requestedSelection?: Pick<CodeReviewAgentConfig, 'provider' | 'model' | 'effort'>,
): { name: string; provider: AgentProviderConfig } {
  const selection = requestedSelection
    || (isCodeReviewTask(task) && requestedProvider
    ? config.agents.codeReview.find((agent) => agent.provider === requestedProvider)
      || { provider: requestedProvider, model: '', effort: '' }
    : agentSelectionForTask(config, task));
  const name = requestedSelection?.provider || requestedProvider || selection.provider;
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
