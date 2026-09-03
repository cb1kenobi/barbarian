import type { AgentProviderConfig, AgentSelectionConfig, BarbarianConfig } from './types.js';

export function isCodeReviewTask(task: string): boolean {
  return task === 'local_branch_review' || task.startsWith('code_review:');
}

export function agentSelectionForTask(config: BarbarianConfig, task: string): AgentSelectionConfig {
  return isCodeReviewTask(task) ? config.agents.codeReview : config.agents.chat;
}

export function configuredAgentForTask(
  config: BarbarianConfig,
  task: string,
  requestedProvider?: string,
): { name: string; provider: AgentProviderConfig } {
  const selection = agentSelectionForTask(config, task);
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
