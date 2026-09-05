import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { chooseReviewAgent, criteriaForReviewAgent } from './review-router.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function setup(algorithm: BarbarianConfig['agents']['reviewRouting'] = 'round_robin') {
  const directory = mkdtempSync(path.join(tmpdir(), 'barbarian-router-'));
  directories.push(directory);
  const database = new BarbarianDatabase(path.join(directory, 'test.db'));
  const config = {
    agents: {
      codeReview: [
        { id: 'one', provider: 'claude-one', model: 'opus', effort: 'high', priority: 100 },
        { id: 'two', provider: 'claude-two', model: 'opus', effort: 'high', priority: 50 },
        { id: 'three', provider: 'codex', model: '', effort: '', priority: 10 },
      ],
      reviewRouting: algorithm,
      usageHeadroomPercent: 20,
      providers: {
        'claude-one': { command: 'claude', args: ['-p'] },
        'claude-two': { command: 'claude', args: ['-p'] },
        codex: { command: 'codex', args: ['exec', '-'] },
      },
    },
  } as unknown as BarbarianConfig;
  return { database, config };
}

describe('review agent routing', () => {
  it('round robins one agent at a time', async () => {
    const { database, config } = setup();
    const usage = async () => ({ usedPercent: null });
    expect((await chooseReviewAgent(database, config, new Set(), { usageReader: usage })).id).toBe('one');
    expect((await chooseReviewAgent(database, config, new Set(), { usageReader: usage })).id).toBe('two');
    expect((await chooseReviewAgent(database, config, new Set(), { usageReader: usage })).id).toBe('three');
    database.close();
  });

  it('removes providers above the configured usage threshold before applying priority', async () => {
    const { database, config } = setup('priority');
    const selected = await chooseReviewAgent(database, config, new Set(), {
      usageReader: async (provider) => ({ usedPercent: provider === 'claude-one' ? 81 : 40 }),
    });
    expect(selected.id).toBe('two');
    database.close();
  });

  it('forces an exact row first and limits failover to matching criteria', async () => {
    const { database, config } = setup('priority');
    const criteria = criteriaForReviewAgent(config, 'two')!;
    const usage = async () => ({ usedPercent: 10 });
    expect((await chooseReviewAgent(database, config, new Set(), {
      criteria, preferredAgentId: 'two', usageReader: usage,
    })).id).toBe('two');
    expect((await chooseReviewAgent(database, config, new Set(['two']), {
      criteria, usageReader: usage,
    })).id).toBe('one');
    await expect(chooseReviewAgent(database, config, new Set(['one', 'two']), {
      criteria, usageReader: usage,
    })).rejects.toThrow('matches the requested');
    database.close();
  });

  it('random routing selects one untried available row', async () => {
    const { database, config } = setup('random');
    const selected = await chooseReviewAgent(database, config, new Set(['one']), {
      usageReader: async () => ({ usedPercent: 0 }),
    });
    expect(['two', 'three']).toContain(selected.id);
    database.close();
  });
});
