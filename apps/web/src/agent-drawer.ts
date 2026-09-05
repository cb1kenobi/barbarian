export type AgentDrawerState =
  | { view: 'closed' }
  | { view: 'history' }
  | { view: 'run'; runId: number; returnToHistory: boolean };

export function closeAgentDrawer(): AgentDrawerState {
  return { view: 'closed' };
}

export function openAgentHistory(): AgentDrawerState {
  return { view: 'history' };
}

export function openAgentRun(runId: number, returnToHistory = false): AgentDrawerState {
  return { view: 'run', runId, returnToHistory };
}

export function backFromAgentRun(state: AgentDrawerState): AgentDrawerState {
  return state.view === 'run' && state.returnToHistory ? openAgentHistory() : closeAgentDrawer();
}
