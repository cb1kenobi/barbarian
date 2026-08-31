import { z } from 'zod';
import type { BarbarianConfig, DiscoveredIssue } from './types.js';
import { runProcess } from './process.js';

const itemSchema = z.object({
  identifier: z.string(),
  title: z.string(),
  description: z.string().default(''),
  url: z.string().url(),
  updatedAt: z.string(),
  priority: z.number().default(0),
  labels: z.array(z.string()).default([]),
  milestone: z.string().nullable().default(null),
  project: z.string().default('Linear'),
  duplicateOf: z.string().nullable().default(null),
  inProgressUrl: z.string().nullable().default(null),
  fixedBy: z.string().nullable().default(null),
});

export async function discoverLinear(config: BarbarianConfig): Promise<DiscoveredIssue[]> {
  if (!config.linear.enabled) return [];
  const [command, ...args] = config.linear.command;
  if (!command) throw new Error('Linear is enabled but linear.command is empty');
  const result = await runProcess(command, args, { timeoutMs: 120_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Linear adapter failed');
  const items = z.array(itemSchema).parse(JSON.parse(result.stdout));
  return items.map((item) => {
    const number = Number(item.identifier.match(/(\d+)$/)?.[1]);
    if (!Number.isInteger(number)) throw new Error(`Linear identifier must end in a number: ${item.identifier}`);
    return {
      provider: 'linear', repository: item.project, number, title: item.title, body: item.description,
      url: item.url, updatedAt: item.updatedAt, labels: item.labels, milestone: item.milestone,
      duplicateOf: item.duplicateOf, inProgressPr: item.inProgressUrl, fixedBy: item.fixedBy,
      priority: item.priority, priorityReasons: ['Linear priority'],
    };
  });
}
