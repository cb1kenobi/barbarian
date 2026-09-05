import { randomInt } from 'node:crypto';
import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig, CodeReviewAgentConfig } from './types.js';
import { readAgentProviderUsage, type AgentProviderUsage } from './agent-usage.js';
import { agentProviderFamily, type ProviderFamily } from './agent-provider.js';

export interface ReviewAgentCriteria {
  provider: string;
  family: ProviderFamily;
  model: string;
  effort: string;
}

export type UsageReader = (
  providerName: string,
  config: BarbarianConfig,
) => Promise<AgentProviderUsage>;

export interface ReviewAgentAvailability extends CodeReviewAgentConfig {
  usedPercent: number | null;
  available: boolean;
  usageError?: string;
}

export function criteriaForReviewAgent(
  config: BarbarianConfig,
  requestedAgentId?: string,
): ReviewAgentCriteria | undefined {
  if (!requestedAgentId) return undefined;
  const agent = config.agents.codeReview.find((candidate) => candidate.id === requestedAgentId);
  if (!agent) throw new Error(`Code review agent "${requestedAgentId}" is not configured`);
  const provider = config.agents.providers[agent.provider];
  if (!provider) throw new Error(`Agent provider "${agent.provider}" is not configured`);
  return {
    provider: agent.provider,
    family: agentProviderFamily(provider.command),
    model: agent.model,
    effort: agent.effort,
  };
}

function matches(
  config: BarbarianConfig,
  agent: CodeReviewAgentConfig,
  criteria?: ReviewAgentCriteria,
): boolean {
  const family = agentProviderFamily(config.agents.providers[agent.provider]?.command || '');
  return !criteria || (
    (criteria.family === 'unknown' ? agent.provider === criteria.provider : family === criteria.family)
    && agent.model === criteria.model
    && agent.effort === criteria.effort
  );
}

const defaultUsageReader: UsageReader = async (providerName, config) => {
  const provider = config.agents.providers[providerName];
  return provider
    ? readAgentProviderUsage(provider)
    : { usedPercent: null, error: `Agent provider "${providerName}" is not configured` };
};

export async function reviewAgentAvailability(
  config: BarbarianConfig,
  usageReader: UsageReader = defaultUsageReader,
): Promise<ReviewAgentAvailability[]> {
  const limit = 100 - config.agents.usageHeadroomPercent;
  const usageByProvider = new Map<string, Promise<AgentProviderUsage>>();
  return Promise.all(config.agents.codeReview.map(async (agent) => {
    let pending = usageByProvider.get(agent.provider);
    if (!pending) {
      pending = usageReader(agent.provider, config);
      usageByProvider.set(agent.provider, pending);
    }
    const usage = await pending;
    return {
      ...agent,
      usedPercent: usage.usedPercent,
      available: usage.usedPercent === null || usage.usedPercent <= limit,
      ...(usage.error ? { usageError: usage.error } : {}),
    };
  }));
}

function roundRobinAgent(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  candidates: ReviewAgentAvailability[],
): ReviewAgentAvailability {
  const key = 'code_review_round_robin_agent';
  const previous = (database.connection.prepare('SELECT value FROM app_metadata WHERE key=?').get(key) as { value: string } | undefined)?.value;
  const configured = config.agents.codeReview;
  const previousIndex = previous ? configured.findIndex((candidate) => candidate.id === previous) : -1;
  const availableIds = new Set(candidates.map((candidate) => candidate.id));
  const selectedId = Array.from({ length: configured.length }, (_, offset) => (
    configured[(previousIndex + offset + 1) % configured.length]?.id
  )).find((id) => id && availableIds.has(id));
  const selected = candidates.find((candidate) => candidate.id === selectedId) || candidates[0]!;
  database.connection.prepare(`
    INSERT INTO app_metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, selected.id);
  return selected;
}

export async function chooseReviewAgent(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  attempted: ReadonlySet<string>,
  options: {
    criteria?: ReviewAgentCriteria;
    preferredAgentId?: string;
    usageReader?: UsageReader;
  } = {},
): Promise<ReviewAgentAvailability> {
  const matching = (await reviewAgentAvailability(config, options.usageReader || defaultUsageReader))
    .filter((agent) => matches(config, agent, options.criteria) && !attempted.has(agent.id));
  if (!matching.length) {
    throw new Error(options.criteria
      ? 'No untried code review agent matches the requested provider, model, and effort'
      : 'No untried code review agents are configured');
  }
  const available = matching.filter((agent) => agent.available);
  if (!available.length) {
    const threshold = 100 - config.agents.usageHeadroomPercent;
    const usage = matching.map((agent) => `${agent.provider}: ${agent.usedPercent ?? 'unknown'}%`).join(', ');
    throw new Error(`No code review agents are at or below the ${threshold}% usage limit (${usage})`);
  }
  const preferred = options.preferredAgentId
    ? available.find((agent) => agent.id === options.preferredAgentId)
    : undefined;
  if (preferred) return preferred;
  if (config.agents.reviewRouting === 'random') return available[randomInt(available.length)]!;
  if (config.agents.reviewRouting === 'priority') {
    return available.reduce((selected, candidate) => candidate.priority > selected.priority ? candidate : selected);
  }
  return roundRobinAgent(database, config, available);
}
