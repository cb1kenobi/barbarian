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

export interface AgentProviderConfig {
  command: string;
  args: string[];
  model?: string;
}

export interface BarbarianConfig {
  version: number;
  profile: { name: string; timezone: string; githubLogin: string };
  appearance: { theme: 'light' | 'dark' | 'slayer'; fontSize: 'small' | 'normal' };
  monitor: { intervalMinutes: number; runOnStartup: boolean; includeDraftPullRequests: boolean };
  repositories: RepositoryConfig[];
  review: {
    requestedReviewer: string;
    fallbackTeams: string[];
    workspaceRoot: string;
    autoCleanup: boolean;
  };
  linear: { enabled: boolean; command: string[] };
  agents: {
    default: string;
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
