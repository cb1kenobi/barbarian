import { describe, expect, it, vi } from 'vitest';
import {
  agentInvocationArgs, agentProviderCapabilities, agentProviderEnvironment,
  agentProviderSupportsAutomaticWorkspaceWrite, agentProviderSupportsWorkspaceWrite,
} from './agent-provider.js';

describe('agent provider options', () => {
  it('enables networking for read-only Codex questions without granting workspace writes', () => {
    expect(agentInvocationArgs({
      command: 'codex', args: ['exec', '--sandbox=read-only', '--skip-git-repo-check', '-'],
    }, { networkAccess: true })).toEqual([
      'exec', '--skip-git-repo-check',
      '-c', 'shell_environment_policy.ignore_default_excludes=true',
      '-c', expect.stringContaining('shell_environment_policy.exclude=["*KEY*","*SECRET*"'),
      '-c', 'sandbox_mode="read-only"',
      '-c', 'default_permissions="barbarian-review-room"',
      '-c', 'permissions.barbarian-review-room.extends=":read-only"',
      '-c', 'permissions.barbarian-review-room.network.enabled=true',
      '-c', 'project_doc_max_bytes=0', '-c', 'project_doc_fallback_filenames=[]', '-',
    ]);
  });

  it('keeps non-GitHub tokens and key/secret variables excluded from Codex shell tools', () => {
    vi.stubEnv('UNRELATEDTOKEN', 'test-only');
    vi.stubEnv('GH_TOKEN', 'test-only-github');
    try {
      const args = agentInvocationArgs({
        command: 'codex', args: ['exec', '-'], env: { CUSTOM_TOKEN: 'test-only-custom' },
      }, { networkAccess: true });
      const policy = args.find((value) => value.startsWith('shell_environment_policy.exclude='))!;
      const excluded = JSON.parse(policy.slice(policy.indexOf('=') + 1));
      expect(excluded).toEqual(expect.arrayContaining(['*KEY*', '*SECRET*', 'UNRELATEDTOKEN', 'CUSTOM_TOKEN']));
      expect(excluded).not.toContain('GH_TOKEN');
      expect(args.join(' ')).not.toContain('test-only');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('enables networking in an editable Codex room without affecting other writable runs', () => {
    const provider = { command: 'codex', args: ['exec', '-s', 'read-only', '-'] };
    const args = agentInvocationArgs(provider, { workspaceWrite: true, networkAccess: true });
    expect(args).toContain('workspace-write');
    expect(args).toContain('sandbox_workspace_write.network_access=true');
    expect(args).toContain('shell_environment_policy.ignore_default_excludes=true');
    expect(args).not.toContain('default_permissions="barbarian-review-room"');
    expect(agentInvocationArgs(provider, { workspaceWrite: true }))
      .not.toContain('sandbox_workspace_write.network_access=true');
    expect(agentInvocationArgs(provider, { networkAccess: false })).toEqual(provider.args);
  });

  it('leaves network permissions to non-Codex providers', () => {
    for (const command of ['claude', 'cursor-agent', 'gemini', 'custom-reviewer']) {
      expect(agentInvocationArgs({ command, args: ['-p'] }, { networkAccess: true })).toEqual(['-p']);
    }
  });

  it('inherits GitHub authentication only when requested and preserves provider overrides', () => {
    const provider = { command: 'codex', args: [] };
    const base = {
      GH_TOKEN: 'test-gh', GITHUB_TOKEN: 'test-github',
      GH_ENTERPRISE_TOKEN: 'test-enterprise', GITHUB_ENTERPRISE_TOKEN: 'test-github-enterprise',
      OTHER_TOKEN: 'unrelated', PATH: '/bin',
    };
    expect(agentProviderEnvironment(provider, base)).toEqual({ PATH: '/bin' });
    expect(agentProviderEnvironment(provider, base, { githubAuth: true })).toEqual({
      GH_TOKEN: 'test-gh', GITHUB_TOKEN: 'test-github',
      GH_ENTERPRISE_TOKEN: 'test-enterprise', GITHUB_ENTERPRISE_TOKEN: 'test-github-enterprise', PATH: '/bin',
    });
    expect(agentProviderEnvironment({ ...provider, env: { GH_TOKEN: '${OTHER_TOKEN}' } }, base, { githubAuth: true }).GH_TOKEN)
      .toBe('unrelated');
  });

  it('applies Codex model and effort before the stdin prompt', () => {
    expect(agentInvocationArgs({
      command: '/usr/local/bin/codex',
      args: ['exec', '--model', 'old-model', '--sandbox', 'read-only', '-'],
      model: 'gpt-review',
      effort: 'xhigh',
    })).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-review',
      '-c', 'model_reasoning_effort="xhigh"', '-',
    ]);
  });

  it('can grant a Codex branch-room invocation workspace write access', () => {
    expect(agentInvocationArgs({
      command: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'],
    }, { workspaceWrite: true })).toEqual([
      'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write',
      '-c', 'project_doc_max_bytes=0', '-c', 'project_doc_fallback_filenames=[]', '-',
    ]);
  });

  it('removes Cursor read-only modes for a branch-room invocation', () => {
    expect(agentInvocationArgs({
      command: 'cursor-agent', args: ['-p', '--mode', 'ask', '--output-format', 'text'],
    }, { workspaceWrite: true })).toEqual(['-p', '--output-format', 'text']);
  });

  it('applies Claude model and effort flags', () => {
    expect(agentInvocationArgs({
      command: 'claude', args: ['-p', '--effort=low'], model: 'opus', effort: 'high',
    })).toEqual(['-p', '--model', 'opus', '--effort', 'high']);
  });

  it('applies a Gemini model and reports that effort is unavailable', () => {
    expect(agentInvocationArgs({ command: 'gemini', args: [], model: 'gemini-review' }))
      .toEqual(['--model', 'gemini-review']);
    expect(agentProviderCapabilities('gemini')).toEqual({ model: true, effort: false });
  });

  it('applies a Cursor model and reports that effort is encoded by its model ID', () => {
    expect(agentInvocationArgs({
      command: 'cursor-agent', args: ['-p', '--mode', 'ask', '--output-format', 'text'],
      model: 'cursor-grok-4.6-high',
    })).toEqual([
      '-p', '--mode', 'ask', '--output-format', 'text', '--model', 'cursor-grok-4.6-high',
    ]);
    expect(agentProviderCapabilities('/Users/developer/.local/bin/cursor-agent'))
      .toEqual({ model: true, effort: false });
  });

  it('does not invent flags for a custom command', () => {
    expect(agentInvocationArgs({ command: 'custom-reviewer', args: ['review'], model: 'metadata-only' }))
      .toEqual(['review']);
    expect(agentProviderCapabilities('custom-reviewer')).toEqual({ model: false, effort: false });
  });

  it('offers editable workspaces only for providers with a non-interactive write mode', () => {
    expect(agentProviderSupportsWorkspaceWrite('/usr/local/bin/codex')).toBe(true);
    expect(agentProviderSupportsWorkspaceWrite('cursor-agent')).toBe(true);
    expect(agentProviderSupportsWorkspaceWrite('claude')).toBe(false);
    expect(agentProviderSupportsWorkspaceWrite('custom-reviewer')).toBe(false);
  });

  it('limits automatic writable agents to the sandboxed Codex provider', () => {
    expect(agentProviderSupportsAutomaticWorkspaceWrite('/usr/local/bin/codex')).toBe(true);
    expect(agentProviderSupportsAutomaticWorkspaceWrite('cursor-agent')).toBe(false);
    expect(agentProviderSupportsAutomaticWorkspaceWrite('claude')).toBe(false);
  });

  it('resolves per-provider secrets and lets Claude OAuth override inherited API authentication', () => {
    expect(agentProviderEnvironment({
      command: 'claude', args: ['-p'], env: { CLAUDE_CODE_OAUTH_TOKEN: '${SECOND_CLAUDE_TOKEN}' },
    }, {
      SECOND_CLAUDE_TOKEN: 'oauth-token', THIRD_CLAUDE_TOKEN: 'other-oauth-token',
      ANTHROPIC_API_KEY: 'inherited-key', OPENAI_API_KEY: 'other-provider-key',
      GH_TOKEN: 'github-token', SAFE_FLAG: 'yes',
    })).toEqual({ SAFE_FLAG: 'yes', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' });
  });

  it('inherits only the matching provider family credential', () => {
    expect(agentProviderEnvironment({ command: 'codex', args: ['exec', '-'] }, {
      OPENAI_API_KEY: 'codex-key', CODEX_API_KEY: 'codex-account',
      OPENAI_BASE_URL: 'https://example.test/v1',
      CLAUDE_CODE_OAUTH_TOKEN: 'claude-token', CLAUDE_TWO: 'other-claude-account',
      SSH_AUTH_SOCK: '/tmp/ssh.sock', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus',
      TERM_SESSION_ID: 'terminal-session', PATH: '/bin',
    })).toEqual({
      OPENAI_API_KEY: 'codex-key', CODEX_API_KEY: 'codex-account',
      OPENAI_BASE_URL: 'https://example.test/v1',
      SSH_AUTH_SOCK: '/tmp/ssh.sock', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/dbus',
      TERM_SESSION_ID: 'terminal-session', PATH: '/bin',
    });
  });

  it('keeps a safe source variable when a provider adds an alias for it', () => {
    expect(agentProviderEnvironment({
      command: 'custom-reviewer', args: [], env: { REVIEW_PATH: '${PATH}' },
    }, { PATH: '/usr/bin', OTHER_TOKEN: 'secret' })).toEqual({
      PATH: '/usr/bin', REVIEW_PATH: '/usr/bin',
    });
  });
});
