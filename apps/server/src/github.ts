import type {
  BarbarianConfig,
  DiscoveryResult,
  DiscoveredIssue,
  DiscoveredPullRequest,
  RepositoryConfig,
} from './types.js';
import { runProcess } from './process.js';

export interface GithubIssueNode {
  number: number;
  title: string;
  body: string;
  url: string;
  updatedAt: string;
  state?: string;
  assignees: { nodes: Array<{ login: string }> };
  labels: { nodes: Array<{ name: string }> };
  milestone: { title: string } | null;
  closedByPullRequestsReferences: {
    nodes: Array<{ number: number; url: string; state: string; merged: boolean }>;
  };
}

export interface GithubIssueContext {
  issue: DiscoveredIssue;
  state: string;
  assignedToViewerOrUnassigned: boolean;
}

export interface GithubLatestReviewNode {
  author: { login: string } | null;
  state: string;
  commit: { oid: string } | null;
}

interface GithubPullRequestNode {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
  headRefOid: string;
  headRefName: string;
  baseRefName: string;
  reviewDecision: string | null;
  author: { login: string } | null;
  additions: number;
  deletions: number;
  commits: { totalCount: number };
  reviewRequests: {
    nodes: Array<{ requestedReviewer: { login?: string; name?: string } | null }>;
  };
  latestReviews: { nodes: GithubLatestReviewNode[] };
  closingIssuesReferences: { nodes: Array<{ number: number }> };
}

export interface DiscussionEntry {
  id: string;
  fullDatabaseId: string | null;
  updatedAt: string;
  author: { login: string } | null;
  authorAssociation: string;
}

export interface GithubDiscussionNode {
  number: number;
  author: { login: string } | null;
  comments: { nodes: DiscussionEntry[] };
  reviews: { nodes: DiscussionEntry[] };
  reviewThreads: { nodes: Array<{ comments: { nodes: DiscussionEntry[] } }> };
}

interface IssuePageResult {
  data: {
    repository: {
      issues: { nodes: GithubIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } | null;
  };
}

interface PullRequestPageResult {
  data: {
    repository: {
      pullRequests: { nodes: GithubPullRequestNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
    } | null;
  };
}

const repositoryIssuesQuery = `
query($owner:String!, $repo:String!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    issues(first:100, after:$cursor, states:OPEN, orderBy:{field:UPDATED_AT,direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url updatedAt
        assignees(first:10) { nodes { login } }
        labels(first:30) { nodes { name } }
        milestone { title }
        closedByPullRequestsReferences(first:20) { nodes { number url state merged } }
      }
    }
  }
}`;

const issueContextQuery = `
query($owner:String!, $repo:String!, $number:Int!) {
  viewer { login }
  repository(owner:$owner, name:$repo) {
    issue(number:$number) {
      number title body url updatedAt state
      assignees(first:10) { nodes { login } }
      labels(first:30) { nodes { name } }
      milestone { title }
      closedByPullRequestsReferences(first:20) { nodes { number url state merged } }
    }
  }
}`;

const repositoryPullRequestsQuery = `
query($owner:String!, $repo:String!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequests(first:100, after:$cursor, states:OPEN, orderBy:{field:UPDATED_AT,direction:DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title body url state isDraft mergedAt createdAt updatedAt additions deletions
        commits { totalCount }
        headRefOid headRefName baseRefName reviewDecision
        author { login }
        reviewRequests(first:20) {
          nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
        }
        latestReviews(first:100) { nodes { author { login } state commit { oid } } }
        closingIssuesReferences(first:100) { nodes { number } }
      }
    }
  }
}`;

const pullRequestContextQuery = `
query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number title body url state isDraft mergedAt createdAt updatedAt additions deletions
      commits { totalCount }
      headRefOid headRefName baseRefName reviewDecision
      author { login }
      reviewRequests(first:20) {
        nodes { requestedReviewer { ... on User { login } ... on Team { name } } }
      }
      latestReviews(first:100) { nodes { author { login } state commit { oid } } }
      closingIssuesReferences(first:100) { nodes { number } }
    }
  }
}`;

const reviewedPullRequestsQuery = `
query($searchQuery:String!, $cursor:String) {
  search(query:$searchQuery, type:ISSUE, first:100, after:$cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest { number repository { nameWithOwner } }
    }
  }
}`;

async function gh(args: string[]): Promise<string> {
  const result = await runProcess('gh', args, { timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'GitHub CLI request failed');
  return result.stdout;
}

export interface ReviewBundle {
  repository: string;
  number: number;
  metadata: Record<string, unknown>;
  diff: string;
  inlineComments: unknown[];
  issueComments: unknown[];
}

export interface ReviewCommentDraft {
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
  body: string;
}

function commentLocation(path: string, side: 'LEFT' | 'RIGHT', line: number): string {
  return `${path}\0${side}\0${line}`;
}

/** Return every single-line location GitHub accepts for an inline comment in a unified diff. */
export function reviewableDiffLines(diff: string): Set<string> {
  const locations = new Set<string>();
  let file = '';
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = '';
      inHunk = false;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const value = line.slice(4);
      file = value === '/dev/null' ? '' : value.replace(/^b\//, '');
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = Boolean(file);
      continue;
    }
    if (!inHunk || !file || line.startsWith('\\ No newline at end of file')) continue;
    if (line.startsWith('+')) {
      locations.add(commentLocation(file, 'RIGHT', newLine));
      newLine += 1;
    } else if (line.startsWith('-')) {
      locations.add(commentLocation(file, 'LEFT', oldLine));
      oldLine += 1;
    } else {
      // GitHub locates unchanged context on the right side of the diff.
      locations.add(commentLocation(file, 'RIGHT', newLine));
      oldLine += 1;
      newLine += 1;
    }
  }
  return locations;
}

export function validateReviewCommentLocations(diff: string, comments: ReviewCommentDraft[]): void {
  const locations = reviewableDiffLines(diff);
  for (const [index, comment] of comments.entries()) {
    if (!locations.has(commentLocation(comment.path, comment.side, comment.line))) {
      throw new Error(`Review comment ${index + 1} does not point to a changed diff line`);
    }
  }
}

export async function fetchPullRequestReviewBundle(repository: string, number: number): Promise<ReviewBundle> {
  const commands = [
    ['pr', 'view', String(number), '--repo', repository, '--json', 'number,title,body,url,author,headRefOid,headRefName,baseRefName,files,commits,closingIssuesReferences,reviews,reviewDecision,statusCheckRollup'],
    ['pr', 'diff', String(number), '--repo', repository],
    ['api', `repos/${repository}/pulls/${number}/comments?per_page=100`, '--paginate', '--slurp'],
    ['api', `repos/${repository}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp'],
  ];
  const results = await Promise.all(commands.map(async (args) => {
    const result = await runProcess('gh', args, { timeoutMs: 120_000, maxOutputCharacters: 4_000_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'GitHub CLI request failed');
    return result.stdout;
  }));
  if (results.some((result) => result.startsWith('[... '))) {
    throw new Error('Pull request review bundle exceeded the safe capture limit');
  }
  const inlinePages = JSON.parse(results[2] || '[]') as unknown[][];
  const issuePages = JSON.parse(results[3] || '[]') as unknown[][];
  return {
    repository,
    number,
    metadata: JSON.parse(results[0] || '{}') as Record<string, unknown>,
    diff: results[1] || '',
    inlineComments: inlinePages.flat(),
    issueComments: issuePages.flat(),
  };
}

export async function postPullRequestReview(
  repository: string,
  number: number,
  headSha: string,
  summary: string,
  comments: ReviewCommentDraft[],
  reviewName = '',
): Promise<void> {
  const publication = reviewPublication(repository, number, headSha, summary, comments, reviewName);
  const result = await runProcess('gh', [
    'api', '--method', 'POST', publication.endpoint, '--input', '-',
  ], {
    input: JSON.stringify(publication.payload),
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Could not publish the GitHub review result');
}

function withoutReviewAttribution(body: string): string {
  return body
    .replace(/\n{2,}—\s*\n_Generated by Barber AI_\s*$/i, '')
    .replace(/\n{2,}—\s*\n(?:[^\r\n]{1,80}\s+)?reviewed\s+[A-Za-z0-9._-]{7,64}\s*$/i, '')
    .trimEnd();
}

export function reviewAttribution(headSha: string, reviewName = ''): string {
  const name = reviewName.trim();
  return `${name ? `${name} reviewed` : 'Reviewed'} ${headSha.slice(0, 8)}`;
}

export function reviewPublicationPayload(headSha: string, comments: ReviewCommentDraft[], reviewName = '') {
  if (comments.length === 0) throw new Error('Refusing to publish an empty pull request review');
  const signature = `—\n${reviewAttribution(headSha, reviewName)}`;
  const signedComments = comments.map((comment) => ({
    ...comment,
    body: `${withoutReviewAttribution(comment.body)}\n\n${signature}`,
  }));
  return { commit_id: headSha, event: 'COMMENT' as const, comments: signedComments };
}

export function reviewPublication(
  repository: string,
  number: number,
  headSha: string,
  _summary: string,
  comments: ReviewCommentDraft[],
  reviewName = '',
): { endpoint: string; payload: Record<string, unknown> } {
  if (comments.length === 0) throw new Error('Refusing to publish a clean review comment');
  return {
    endpoint: `repos/${repository}/pulls/${number}/reviews`,
    payload: reviewPublicationPayload(headSha, comments, reviewName),
  };
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

async function queryRepositoryIssues(repository: RepositoryConfig): Promise<GithubIssueNode[]> {
  const [owner, repo] = splitRepository(repository.name);
  const nodes: GithubIssueNode[] = [];
  let cursor: string | null = null;
  do {
    const raw = await gh([
      'api', 'graphql',
      '-f', `query=${repositoryIssuesQuery}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      ...(cursor ? ['-F', `cursor=${cursor}`] : []),
    ]);
    const result = JSON.parse(raw) as IssuePageResult;
    if (!result.data.repository) throw new Error('repository was not found or is inaccessible');
    nodes.push(...result.data.repository.issues.nodes);
    cursor = result.data.repository.issues.pageInfo.hasNextPage
      ? result.data.repository.issues.pageInfo.endCursor
      : null;
  } while (cursor);
  return nodes;
}

async function queryRepositoryPullRequests(repository: RepositoryConfig): Promise<GithubPullRequestNode[]> {
  const [owner, repo] = splitRepository(repository.name);
  const nodes: GithubPullRequestNode[] = [];
  let cursor: string | null = null;
  do {
    const raw = await gh([
      'api', 'graphql',
      '-f', `query=${repositoryPullRequestsQuery}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      ...(cursor ? ['-F', `cursor=${cursor}`] : []),
    ]);
    const result = JSON.parse(raw) as PullRequestPageResult;
    if (!result.data.repository) throw new Error('repository was not found or is inaccessible');
    nodes.push(...result.data.repository.pullRequests.nodes);
    cursor = result.data.repository.pullRequests.pageInfo.hasNextPage
      ? result.data.repository.pullRequests.pageInfo.endCursor
      : null;
  } while (cursor);
  return nodes;
}

async function queryReviewedPullRequests(login: string): Promise<Set<string>> {
  const reviewed = new Set<string>();
  let cursor: string | null = null;
  do {
    const raw = await gh([
      'api', 'graphql',
      '-f', `query=${reviewedPullRequestsQuery}`,
      '-F', `searchQuery=is:pr is:open reviewed-by:${login}`,
      ...(cursor ? ['-F', `cursor=${cursor}`] : []),
    ]);
    const result = JSON.parse(raw) as {
      data: {
        search: {
          nodes: Array<{ number: number; repository: { nameWithOwner: string } } | null>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    for (const node of result.data.search.nodes) {
      if (node) reviewed.add(`${node.repository.nameWithOwner}#${node.number}`.toLowerCase());
    }
    cursor = result.data.search.pageInfo.hasNextPage ? result.data.search.pageInfo.endCursor : null;
  } while (cursor);
  return reviewed;
}

const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function discussionWatermark(node: GithubDiscussionNode | undefined, githubLogin: string): string {
  if (!node) return '';
  const author = node.author?.login.toLowerCase() || '';
  const self = githubLogin.toLowerCase();
  const entries = [
    ...node.comments.nodes,
    ...node.reviews.nodes,
    ...node.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes),
  ].filter((entry) => {
    const login = entry.author?.login.toLowerCase();
    return Boolean(login && login !== self && (login === author || trustedAssociations.has(entry.authorAssociation)));
  });
  let watermark = '';
  for (const entry of entries) {
    const numericId = String(entry.fullDatabaseId || '').padStart(24, '0');
    const candidate = `${entry.updatedAt}|${numericId}|${entry.id}`;
    if (candidate > watermark) watermark = candidate;
  }
  return watermark;
}

export function priorityFor(issue: GithubIssueNode, repository: RepositoryConfig): { score: number; reasons: string[] } {
  let score = repository.priority;
  const reasons = repository.priority ? [`repository +${repository.priority}`] : [];
  const text = `${issue.title}\n${issue.body}`.toLowerCase();
  if (/data[ -]?loss|corrupt(?:ion|ed)|durability|lost write/.test(text)) {
    score += 150;
    reasons.push('data integrity +150');
  }
  if (issue.milestone) {
    score += 30;
    reasons.push(`milestone +30`);
  }
  const standardLabelWeights: Array<[RegExp, number, string]> = [
    [/^(?:p0|priority[: /-]*p?0|critical|blocker|severity[: /-]*critical)$/i, 200, 'P0 / critical'],
    [/^(?:p1|priority[: /-]*p?1|high|severity[: /-]*high)$/i, 120, 'P1 / high'],
    [/^(?:p2|priority[: /-]*p?2|medium|severity[: /-]*medium)$/i, 60, 'P2 / medium'],
    [/^(?:p3|priority[: /-]*p?3|low|severity[: /-]*low)$/i, 20, 'P3 / low'],
  ];
  for (const label of issue.labels.nodes) {
    const weight = repository.labels[label.name] ?? repository.labels[label.name.toLowerCase()];
    if (weight) {
      score += weight;
      reasons.push(`${label.name} +${weight}`);
      continue;
    }
    const standard = standardLabelWeights.find(([pattern]) => pattern.test(label.name.trim()));
    if (standard) {
      score += standard[1];
      reasons.push(`${standard[2]} +${standard[1]}`);
    }
  }
  return { score, reasons };
}

export function assignedToViewerOrUnassigned(issue: GithubIssueNode, githubLogin: string): boolean {
  return issue.assignees.nodes.length === 0
    || issue.assignees.nodes.some((assignee) => assignee.login.toLowerCase() === githubLogin.toLowerCase());
}

function issueReference(body: string): string | null {
  const match = body.match(/(?:duplicate of|dupe of|superseded by)\s+(?:[\w.-]+\/[\w.-]+)?#(\d+)/i);
  return match?.[1] ? `#${match[1]}` : null;
}

function convertIssue(repository: RepositoryConfig, node: GithubIssueNode): DiscoveredIssue {
  const linked = node.closedByPullRequestsReferences.nodes;
  const openPr = linked.find((pr) => pr.state === 'OPEN');
  const mergedPr = linked.find((pr) => pr.merged);
  const priority = priorityFor(node, repository);
  return {
    provider: 'github', repository: repository.name, number: node.number,
    title: node.title, body: node.body || '', url: node.url, updatedAt: node.updatedAt,
    assignees: node.assignees.nodes.map((assignee) => assignee.login),
    labels: node.labels.nodes.map((label) => label.name), milestone: node.milestone?.title ?? null,
    duplicateOf: node.labels.nodes.some((label) => label.name.toLowerCase() === 'duplicate')
      ? issueReference(node.body || '') || 'marked duplicate'
      : issueReference(node.body || ''),
    inProgressPr: openPr?.url ?? null,
    fixedBy: mergedPr?.url ?? null,
    priority: priority.score,
    priorityReasons: priority.reasons,
  };
}

export async function fetchGithubIssueContext(
  repository: RepositoryConfig,
  number: number,
): Promise<GithubIssueContext> {
  const [owner, repo] = splitRepository(repository.name);
  const raw = await gh([
    'api', 'graphql',
    '-f', `query=${issueContextQuery}`,
    '-F', `owner=${owner}`,
    '-F', `repo=${repo}`,
    '-F', `number=${number}`,
  ]);
  const result = JSON.parse(raw) as {
    data: {
      viewer: { login: string };
      repository: { issue: GithubIssueNode | null } | null;
    };
  };
  const node = result.data.repository?.issue;
  if (!node) throw new Error(`${repository.name}#${number} was not found`);
  return {
    issue: convertIssue(repository, node),
    state: node.state || 'OPEN',
    assignedToViewerOrUnassigned: assignedToViewerOrUnassigned(node, result.data.viewer.login),
  };
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

function convertPullRequest(
  repository: string,
  node: GithubPullRequestNode,
  reviewedBy: string[],
  reviewTarget: string,
): DiscoveredPullRequest {
  const reviewers: string[] = [];
  const teams: string[] = [];
  for (const request of node.reviewRequests.nodes) {
    const target = request.requestedReviewer;
    if (target?.login) reviewers.push(target.login);
    if (target?.name) teams.push(target.name);
  }
  const target = reviewTarget.toLowerCase();
  const viewerReview = node.latestReviews.nodes.find(
    (review) => review.author?.login.toLowerCase() === target,
  );
  const otherApprovals = node.latestReviews.nodes.filter((review) =>
    review.author?.login.toLowerCase() !== target
      && review.state === 'APPROVED'
      && review.commit?.oid === node.headRefOid,
  ).length;
  return {
    provider: 'github',
    repository,
    number: node.number,
    title: node.title,
    body: node.body || '',
    url: node.url,
    author: node.author?.login || 'unknown',
    additions: node.additions,
    deletions: node.deletions,
    commitCount: node.commits.totalCount,
    headSha: node.headRefOid,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    isDraft: node.isDraft,
    reviewDecision: node.reviewDecision,
    requestedReviewers: reviewers,
    requestedTeams: teams,
    reviewedBy,
    viewerReviewState: viewerReview?.state ?? null,
    viewerReviewSha: viewerReview?.commit?.oid ?? null,
    otherApprovals,
    linkedIssues: node.closingIssuesReferences.nodes.map((issue) => issue.number),
    mergedAt: node.mergedAt,
    state: node.state,
    discussionWatermark: '',
  };
}

export async function fetchGithubPullRequest(
  repository: string,
  number: number,
  reviewTarget: string,
): Promise<DiscoveredPullRequest> {
  const [owner, repo] = splitRepository(repository);
  const raw = await gh([
    'api', 'graphql',
    '-f', `query=${pullRequestContextQuery}`,
    '-F', `owner=${owner}`,
    '-F', `repo=${repo}`,
    '-F', `number=${number}`,
  ]);
  const result = JSON.parse(raw) as {
    data: { repository: { pullRequest: GithubPullRequestNode | null } | null };
  };
  const pullRequest = result.data.repository?.pullRequest;
  if (!pullRequest) throw new Error(`${repository}#${number} was not found`);
  const reviewedBy = pullRequest.latestReviews.nodes.flatMap((review) => review.author?.login ? [review.author.login] : []);
  return convertPullRequest(repository, pullRequest, reviewedBy, reviewTarget);
}

export async function discoverGithub(config: BarbarianConfig): Promise<DiscoveryResult> {
  const discoveredAt = new Date().toISOString();
  const githubLogin = await resolveGithubLogin(config);
  const issues: DiscoveredIssue[] = [];
  const pullRequests: DiscoveredPullRequest[] = [];
  const warnings: string[] = [];
  const reviewTarget = config.review.requestedReviewer || githubLogin;
  let reviewedPullRequests = new Set<string>();

  try {
    reviewedPullRequests = await queryReviewedPullRequests(reviewTarget);
  } catch (error) {
    warnings.push(`review history: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const repository of config.repositories) {
    try {
      const [issueNodes, pullRequestNodes] = await Promise.all([
        repository.watchIssues ? queryRepositoryIssues(repository) : Promise.resolve([]),
        repository.watchPullRequests ? queryRepositoryPullRequests(repository) : Promise.resolve([]),
      ]);
      if (repository.watchPullRequests) {
        pullRequests.push(...pullRequestNodes.map((node) => convertPullRequest(
          repository.name,
          node,
          reviewedPullRequests.has(`${repository.name}#${node.number}`.toLowerCase()) ? [reviewTarget] : [],
          reviewTarget,
        )));
      }
      if (repository.watchIssues) {
        for (const node of issueNodes) {
          if (!assignedToViewerOrUnassigned(node, githubLogin)) continue;
          issues.push(convertIssue(repository, node));
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

interface ReviewThreadCommentNode {
  databaseId: number;
  id: string;
  fullDatabaseId: string | null;
  url: string;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: { login: string } | null;
  authorAssociation: string;
}

interface ReviewThreadNode {
  isResolved: boolean;
  isOutdated: boolean;
  comments: { nodes: ReviewThreadCommentNode[] };
  recentComments: { nodes: ReviewThreadCommentNode[] };
}

export interface GithubReviewFinding {
  remoteId: number;
  author: string;
  body: string;
  summary: string;
  url: string;
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  createdAt: string;
}

export interface GithubPullRequestReviewContext {
  state: string;
  mergedAt: string | null;
  reviewDecision: string | null;
  headSha: string;
  additions: number;
  deletions: number;
  commitCount: number;
  viewerReviewState: string | null;
  viewerReviewSha: string | null;
  otherApprovals: number;
  discussionWatermark: string;
  findings: GithubReviewFinding[];
}

export function isAiReviewComment(author: string, body: string): boolean {
  return /(?:^|[-_])(claude|gemini|codex|copilot|coderabbit|chatgpt|ai)(?:[-_]|$)/i.test(author)
    || /generated by (?:barber|[^\n]{0,30}\bai\b)|🤖|—\s*(?:claude|codex|gemini)/i.test(body)
    || /—\s*\n(?:[^\r\n]{1,80}\s+)?reviewed\s+[A-Za-z0-9._-]{7,64}\s*$/im.test(body);
}

export function summarizeReviewComment(body: string): string {
  const heading = body.match(/^#{1,6}\s+(.+)$/m)?.[1];
  const clean = (heading || body)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/```[^]*?```/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length <= 180 ? clean : `${clean.slice(0, 179).trimEnd()}…`;
}

const reviewContextQuery = `
query($owner:String!, $repo:String!, $number:Int!, $cursor:String) {
  viewer { login }
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      state mergedAt reviewDecision headRefOid additions deletions author { login }
      commits { totalCount }
      latestReviews(first:100) { nodes { author { login } state commit { oid } } }
      comments(last:100) { nodes { id fullDatabaseId updatedAt author { login } authorAssociation } }
      reviews(last:100) { nodes { id fullDatabaseId updatedAt author { login } authorAssociation } }
      reviewThreads(first:100, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated
          comments(first:1) {
            nodes { databaseId id fullDatabaseId url path line originalLine body createdAt updatedAt author { login } authorAssociation }
          }
          recentComments: comments(last:100) {
            nodes { databaseId id fullDatabaseId url path line originalLine body createdAt updatedAt author { login } authorAssociation }
          }
        }
      }
    }
  }
}`;

export async function fetchPullRequestReviewContext(
  repository: string,
  number: number,
): Promise<GithubPullRequestReviewContext> {
  const [owner, repo] = splitRepository(repository);
  let cursor: string | null = null;
  let pullRequest: {
    state: string;
    mergedAt: string | null;
    reviewDecision: string | null;
    headRefOid: string;
    additions: number;
    deletions: number;
    commits: { totalCount: number };
    author: { login: string } | null;
    comments: { nodes: DiscussionEntry[] };
    reviews: { nodes: DiscussionEntry[] };
    latestReviews: { nodes: GithubLatestReviewNode[] };
  } | null = null;
  let viewerLogin = '';
  const threads: ReviewThreadNode[] = [];
  do {
    const args = [
      'api', 'graphql',
      '-f', `query=${reviewContextQuery}`,
      '-F', `owner=${owner}`,
      '-F', `repo=${repo}`,
      '-F', `number=${number}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);
    const raw = await gh(args);
    const result = JSON.parse(raw) as {
      data: { viewer: { login: string }; repository: { pullRequest: {
        state: string;
        mergedAt: string | null;
        reviewDecision: string | null;
        headRefOid: string;
        additions: number;
        deletions: number;
        commits: { totalCount: number };
        author: { login: string } | null;
        comments: { nodes: DiscussionEntry[] };
        reviews: { nodes: DiscussionEntry[] };
        latestReviews: { nodes: GithubLatestReviewNode[] };
        reviewThreads: {
          nodes: ReviewThreadNode[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      } | null } | null };
    };
    const page = result.data.repository?.pullRequest;
    if (!page) throw new Error(`${repository}#${number} was not found`);
    pullRequest = page;
    viewerLogin = result.data.viewer.login;
    threads.push(...page.reviewThreads.nodes);
    cursor = page.reviewThreads.pageInfo.hasNextPage ? page.reviewThreads.pageInfo.endCursor : null;
  } while (cursor);

  const findings = threads.flatMap((thread) => {
    const comment = thread.comments.nodes[0];
    if (!comment || !isAiReviewComment(comment.author?.login || '', comment.body)) return [];
    return [{
      remoteId: comment.databaseId,
      author: comment.author?.login || 'AI reviewer',
      body: comment.body,
      summary: summarizeReviewComment(comment.body),
      url: comment.url,
      path: comment.path,
      line: comment.line || comment.originalLine,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      createdAt: comment.createdAt,
    }];
  });
  const discussionNode: GithubDiscussionNode = {
    number,
    author: pullRequest.author,
    comments: pullRequest.comments,
    reviews: pullRequest.reviews,
    reviewThreads: { nodes: threads.map((thread) => ({ comments: { nodes: thread.recentComments.nodes } })) },
  };
  const self = viewerLogin.toLowerCase();
  const viewerReview = pullRequest.latestReviews.nodes.find(
    (review) => review.author?.login.toLowerCase() === self,
  );
  const otherApprovals = pullRequest.latestReviews.nodes.filter((review) =>
    review.author?.login.toLowerCase() !== self
      && review.state === 'APPROVED'
      && review.commit?.oid === pullRequest.headRefOid,
  ).length;
  return {
    state: pullRequest.state,
    mergedAt: pullRequest.mergedAt,
    reviewDecision: pullRequest.reviewDecision,
    headSha: pullRequest.headRefOid,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    commitCount: pullRequest.commits.totalCount,
    viewerReviewState: viewerReview?.state ?? null,
    viewerReviewSha: viewerReview?.commit?.oid ?? null,
    otherApprovals,
    discussionWatermark: discussionWatermark(discussionNode, viewerLogin),
    findings,
  };
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
