import type {
  BarbarianConfig,
  DiscoveryResult,
  DiscoveredIssue,
  DiscoveredPullRequest,
  RepositoryConfig,
} from './types.js';
import { runProcess } from './process.js';

interface GithubIssueNode {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  labels: { nodes: Array<{ name: string }> };
  milestone: { title: string } | null;
  closedByPullRequestsReferences: {
    nodes: Array<{ number: number; url: string; state: string; merged: boolean }>;
  };
}

interface GithubPullRequestNode {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  updatedAt: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  author: { login: string } | null;
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string; name?: string } | null }>;
  };
  closingIssuesReferences: { nodes: Array<{ number: number }> };
}

interface RepoQueryResult {
  data: {
    repository: {
      issues: { nodes: GithubIssueNode[] };
      pullRequests: { nodes: GithubPullRequestNode[] };
    } | null;
  };
}

const repositoryQuery = `
query($owner:String!, $repo:String!, $login:String!) {
  repository(owner:$owner, name:$repo) {
    issues(first:100, states:OPEN, filterBy:{assignee:$login}, orderBy:{field:UPDATED_AT,direction:DESC}) {
      nodes {
        number title body url updatedAt
        labels(first:30) { nodes { name } }
        milestone { title }
        closedByPullRequestsReferences(first:20) { nodes { number url state merged } }
      }
    }
    pullRequests(first:100, states:OPEN, orderBy:{field:UPDATED_AT,direction:DESC}) {
      nodes {
        number title body url state isDraft mergedAt updatedAt
        headRefOid headRefName baseRefName reviewDecision
        author { login }
        reviewRequests(first:20) {
          nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
        }
        closingIssuesReferences(first:20) { nodes { number } }
      }
    }
  }
}`;

async function gh(args: string[]): Promise<string> {
  const result = await runProcess('gh', args, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'GitHub CLI request failed');
  return result.stdout;
}

export async function resolveGithubLogin(config: BarbarianConfig): Promise<string> {
  if (config.profile.githubLogin) return config.profile.githubLogin;
  return (await gh(['api', 'user', '--jq', '.login'])).trim();
}

function splitRepository(name: string): [string, string] {
  const [owner, repo] = name.split('/');
  if (!owner || !repo) throw new Error(`Invalid repository name: ${name}`);
  return [owner, repo];
}

async function queryRepository(repository: RepositoryConfig, login: string): Promise<RepoQueryResult> {
  const [owner, repo] = splitRepository(repository.name);
  const raw = await gh([
    'api', 'graphql',
    '-f', `query=${repositoryQuery}`,
    '-F', `owner=${owner}`,
    '-F', `repo=${repo}`,
    '-F', `login=${login}`,
  ]);
  return JSON.parse(raw) as RepoQueryResult;
}

function priorityFor(issue: GithubIssueNode, repository: RepositoryConfig): { score: number; reasons: string[] } {
  let score = repository.priority;
  const reasons = repository.priority ? [`repository +${repository.priority}`] : [];
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  if (/data[ -]?loss|corrupt(?:ion|ed)|durability|lost write/.test(text)) {
    score += 150;
    reasons.push('data integrity +150');
  }
  if (repository.name.toLowerCase().includes('rocksdb-js')) {
    score += 100;
    reasons.push('rocksdb-js +100');
  }
  if (issue.milestone) {
    score += 30;
    reasons.push(`milestone +30`);
  }
  for (const label of issue.labels.nodes) {
    const weight = repository.labels[label.name] ?? repository.labels[label.name.toLowerCase()];
    if (weight) {
      score += weight;
      reasons.push(`${label.name} +${weight}`);
    }
  }
  return { score, reasons };
}

function issueReference(body: string): string | null {
  const match = body.match(/(?:duplicate of|dupe of|superseded by)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i);
  return match?.[1] ? `#${match[1]}` : null;
}

function titleTokens(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((word) => word.length > 3));
}

function similarity(left: string, right: string): number {
  const a = titleTokens(left);
  const b = titleTokens(right);
  if (!a.size || !b.size) return 0;
  const common = [...a].filter((word) => b.has(word)).length;
  return common / new Set([...a, ...b]).size;
}

function convertPullRequest(repository: string, node: GithubPullRequestNode): DiscoveredPullRequest {
  const reviewers: string[] = [];
  const teams: string[] = [];
  for (const request of node.reviewRequests.nodes) {
    const target = request.requestedReviewer;
    if (target?.login) reviewers.push(target.login);
    if (target?.name) teams.push(target.name);
  }
  return {
    provider: 'github',
    repository,
    number: node.number,
    title: node.title,
    body: node.body || '',
    url: node.url,
    author: node.author?.login || 'unknown',
    headSha: node.headRefOid,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft,
    reviewDecision: node.reviewDecision,
    requestedReviewers: reviewers,
    requestedTeams: teams,
    linkedIssues: node.closingIssuesReferences.nodes.map((issue) => issue.number),
    mergedAt: node.mergedAt,
    state: node.state,
  };
}

export async function discoverGithub(config: BarbarianConfig): Promise<DiscoveryResult> {
  const discoveredAt = new Date().toISOString();
  const githubLogin = await resolveGithubLogin(config);
  const issues: DiscoveredIssue[] = [];
  const pullRequests: DiscoveredPullRequest[] = [];
  const warnings: string[] = [];

  for (const repository of config.repositories) {
    try {
      const result = await queryRepository(repository, githubLogin);
      if (!result.data.repository) {
        warnings.push(`${repository.name}: repository was not found or is inaccessible`);
        continue;
      }
      if (repository.watchPullRequests) {
        pullRequests.push(...result.data.repository.pullRequests.nodes.map((node) => convertPullRequest(repository.name, node)));
      }
      if (repository.watchIssues) {
        for (const node of result.data.repository.issues.nodes) {
          const linked = node.closedByPullRequestsReferences.nodes;
          const openPr = linked.find((pr) => pr.state === 'OPEN');
          const mergedPr = linked.find((pr) => pr.merged);
          const priority = priorityFor(node, repository);
          issues.push({
            provider: 'github', repository: repository.name, number: node.number,
            title: node.title, body: node.body || '', url: node.url, updatedAt: node.updatedAt,
            labels: node.labels.nodes.map((label) => label.name), milestone: node.milestone?.title ?? null,
            duplicateOf: node.labels.nodes.some((label) => label.name.toLowerCase() === 'duplicate')
              ? issueReference(node.body || '') || 'marked duplicate'
              : issueReference(node.body || ''),
            inProgressPr: openPr?.url ?? null,
            fixedBy: mergedPr?.url ?? null,
            priority: priority.score,
            priorityReasons: priority.reasons,
          });
        }
      }
    } catch (error) {
      warnings.push(`${repository.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (let index = 0; index < issues.length; index += 1) {
    const issue = issues[index];
    if (!issue || issue.duplicateOf) continue;
    const earlier = issues.slice(0, index).find((candidate) =>
      candidate.repository === issue.repository && similarity(candidate.title, issue.title) >= 0.8,
    );
    if (earlier) issue.duplicateOf = `${earlier.repository}#${earlier.number} (similar title)`;
  }

  issues.sort((a, b) => b.priority - a.priority || b.updatedAt.localeCompare(a.updatedAt));
  return { discoveredAt, githubLogin, issues, pullRequests, warnings };
}

export async function fetchPullRequestState(repository: string, number: number): Promise<{ state: string; mergedAt: string | null }> {
  const raw = await gh(['pr', 'view', String(number), '--repo', repository, '--json', 'state,mergedAt']);
  return JSON.parse(raw) as { state: string; mergedAt: string | null };
}

interface ContributionNode {
  occurredAt: string;
  pullRequest?: { number: number; title: string; url: string; repository: { nameWithOwner: string } };
  issue?: { number: number; title: string; url: string; repository: { nameWithOwner: string } };
  pullRequestReview?: {
    databaseId: number;
    state: string;
    pullRequest: { number: number; title: string; url: string; repository: { nameWithOwner: string } };
  };
}

export interface GithubActivity {
  kind: 'pr_created' | 'review_completed' | 'issue_created' | 'issue_resolved';
  occurredAt: string;
  remoteKey: string;
  repository: string;
  number: number;
  title: string;
  url: string;
}

const contributionsQuery = `
query($login:String!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from, to:$to) {
      pullRequestContributions(first:100) { nodes { occurredAt pullRequest { number title url repository { nameWithOwner } } } }
      pullRequestReviewContributions(first:100) { nodes { occurredAt pullRequestReview { databaseId state pullRequest { number title url repository { nameWithOwner } } } } }
      issueContributions(first:100) { nodes { occurredAt issue { number title url repository { nameWithOwner } } } }
    }
  }
}`;

export async function discoverGithubActivity(login: string, from: Date, watchedRepositories: Set<string>): Promise<GithubActivity[]> {
  const raw = await gh([
    'api', 'graphql', '-f', `query=${contributionsQuery}`, '-F', `login=${login}`,
    '-F', `from=${from.toISOString()}`, '-F', `to=${new Date().toISOString()}`,
  ]);
  const parsed = JSON.parse(raw) as { data: { user: { contributionsCollection: {
    pullRequestContributions: { nodes: ContributionNode[] };
    pullRequestReviewContributions: { nodes: ContributionNode[] };
    issueContributions: { nodes: ContributionNode[] };
  } } | null } };
  const collection = parsed.data.user?.contributionsCollection;
  if (!collection) return [];
  const activities: GithubActivity[] = [];
  for (const node of collection.pullRequestContributions.nodes) {
    if (!node.pullRequest || !watchedRepositories.has(node.pullRequest.repository.nameWithOwner)) continue;
    activities.push({ kind: 'pr_created', occurredAt: node.occurredAt, remoteKey: `github:pr-created:${node.pullRequest.repository.nameWithOwner}#${node.pullRequest.number}`, repository: node.pullRequest.repository.nameWithOwner, number: node.pullRequest.number, title: node.pullRequest.title, url: node.pullRequest.url });
  }
  for (const node of collection.pullRequestReviewContributions.nodes) {
    const review = node.pullRequestReview;
    if (!review || !watchedRepositories.has(review.pullRequest.repository.nameWithOwner)) continue;
    activities.push({ kind: 'review_completed', occurredAt: node.occurredAt, remoteKey: `github:review:${review.databaseId}`, repository: review.pullRequest.repository.nameWithOwner, number: review.pullRequest.number, title: review.pullRequest.title, url: review.pullRequest.url });
  }
  for (const node of collection.issueContributions.nodes) {
    if (!node.issue || !watchedRepositories.has(node.issue.repository.nameWithOwner)) continue;
    activities.push({ kind: 'issue_created', occurredAt: node.occurredAt, remoteKey: `github:issue-created:${node.issue.repository.nameWithOwner}#${node.issue.number}`, repository: node.issue.repository.nameWithOwner, number: node.issue.number, title: node.issue.title, url: node.issue.url });
  }
  const since = from.toISOString().slice(0, 10);
  const resolved = await Promise.allSettled([...watchedRepositories].map(async (repository) => {
    const search = await gh([
      'api', '--method', 'GET', 'search/issues',
      '-f', `q=repo:${repository} is:issue assignee:${login} closed:>=${since}`,
      '-f', 'per_page=100',
    ]);
    return { repository, items: (JSON.parse(search) as { items: Array<{ number: number; title: string; html_url: string; closed_at: string }> }).items };
  }));
  for (const result of resolved) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value.items) {
      activities.push({
        kind: 'issue_resolved', occurredAt: item.closed_at,
        remoteKey: `github:issue-resolved:${result.value.repository}#${item.number}`,
        repository: result.value.repository, number: item.number, title: item.title, url: item.html_url,
      });
    }
  }
  return activities;
}
