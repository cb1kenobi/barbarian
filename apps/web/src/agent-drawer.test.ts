import { describe, expect, it } from 'vitest';
import { backFromAgentRun, closeAgentDrawer, openAgentHistory, openAgentRun } from './agent-drawer.js';

describe('agent drawer navigation', () => {
  it('returns history-selected runs to history', () => {
    expect(backFromAgentRun(openAgentRun(42, true))).toEqual({ view: 'history' });
  });

  it('closes directly opened active runs', () => {
    expect(backFromAgentRun(openAgentRun(42))).toEqual({ view: 'closed' });
  });

  it('provides explicit history and closed states', () => {
    expect(openAgentHistory()).toEqual({ view: 'history' });
    expect(closeAgentDrawer()).toEqual({ view: 'closed' });
  });
});
