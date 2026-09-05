export type ReviewStatus =
  | 'unreviewed'
  | 'agent_working'
  | 'issues_found'
  | 'awaiting_feedback'
  | 'agent_failed'
  | 'ready_to_merge'
  | 'approved'
  | 'merged'
  | 'closed';

export interface RepositoryConfig {
  name: string;
  priority: number;
  watchIssues: boolean;
  watchPullRequests: boolean;
  reviewSkill: string;
  labels: Record<string, number>;
}

export type AgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type BrandWeapon = 'double-axe' | 'sword' | 'crossed-swords' | 'single-axe' | 'mace' | 'flail' | 'nunchucks' | 'hammer';

export interface AgentProviderConfig {
  command: string;
  args: string[];
  /** Environment passed only to this provider. A value like ${TOKEN_NAME} reads from Barbarian's .env. */
  env?: Record<string, string>;
  /** Optional command whose stdout is a percentage or {"usedPercent": number}. */
  usageCommand?: string[];
  /** @deprecated Model and effort now belong to a task-specific agent selection. */
  model?: string;
  /** @deprecated Model and effort now belong to a task-specific agent selection. */
  effort?: AgentEffort;
}

export interface AgentSelectionConfig {
  provider: string;
  model: string;
  effort: AgentEffort | '';
}

export interface CodeReviewAgentConfig {
  id: string;
  provider: string;
  model: string;
  effort: AgentEffort | '';
  priority: number;
}

export type ReviewRoutingAlgorithm = 'random' | 'round_robin' | 'priority';

export interface BarbarianConfig {
  version: number;
  server: { bindAddress: '127.0.0.1' | '0.0.0.0'; port: number; trustedHosts: string[] };
  desktop: { launchAtLogin: boolean; globalShortcut: string };
  profile: { name: string; reviewName: string; timezone: string; githubLogin: string };
  appearance: { theme: 'light' | 'dark' | 'slayer'; fontSize: 'small' | 'normal'; weapon: BrandWeapon };
  monitor: { intervalMinutes: number; runOnStartup: boolean };
  repositories: RepositoryConfig[];
  review: {
    requestedReviewer: string;
    fallbackTeams: string[];
    workspaceRoot: string;
    autoCleanup: boolean;
  };
  linear: { enabled: boolean; command: string[] };
  agents: {
    codeReview: CodeReviewAgentConfig[];
    chat: AgentSelectionConfig;
    reviewRouting: ReviewRoutingAlgorithm;
    usageHeadroomPercent: number;
    autoReview: boolean;
    maxConcurrent: number;
    maxAutomaticAttempts: number;
    retryBaseMinutes: number;
    maxRunsPerPullRequestPerHour: number;
    providers: Record<string, AgentProviderConfig>;
  };
  statusUpdate: { enabled: boolean; workdays: string[]; daysOff: string[] };
}

export interface DiscoveredIssue {
  provider: 'github' | 'linear';
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  labels: string[];
  assignees: string[];
  milestone: string | null;
  duplicateOf: string | null;
  inProgressPr: string | null;
  fixedBy: string | null;
  priority: number;
  priorityReasons: string[];
}

export interface DiscoveredPullRequest {
  provider: 'github';
  repository: string;
  number: number;
  title: string;
  body: string;
  url: string;
  author: string;
  additions: number;
  deletions: number;
  commitCount: number;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  isDraft: boolean;
  reviewDecision: string | null;
  requestedReviewers: string[];
  requestedTeams: string[];
  reviewedBy: string[];
  viewerReviewState: string | null;
  viewerReviewSha: string | null;
  otherApprovals: number;
  linkedIssues: number[];
  mergedAt: string | null;
  state: string;
  discussionWatermark: string;
}

export interface DiscoveryResult {
  discoveredAt: string;
  githubLogin: string;
  issues: DiscoveredIssue[];
  pullRequests: DiscoveredPullRequest[];
  warnings: string[];
}
