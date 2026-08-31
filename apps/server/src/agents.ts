import type { BarbarianDatabase } from './database.js';
import type { BarbarianConfig } from './types.js';
import { runProcess } from './process.js';
import { recordActivity } from './activity.js';

interface ReviewRow {
  id: string;
  repository: string;
  number: number;
  title: string;
  simple_summary: string;
  url: string;
  review_skill: string;
  head_sha: string;
}

function providerFor(config: BarbarianConfig, requested?: string) {
  const name = requested || config.agents.default;
  const provider = config.agents.providers[name];
  if (!provider) throw new Error(`Agent provider "${name}" is not configured`);
  return { name, provider };
}

async function executeAgent(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
  task: string,
  prompt: string,
  requestedProvider?: string,
): Promise<string> {
  const { name, provider } = providerFor(config, requestedProvider);
  const startedAt = new Date().toISOString();
  const inserted = database.connection.prepare(`
    INSERT INTO agent_runs(review_id, provider, task, status, started_at) VALUES (?, ?, ?, 'running', ?)
  `).run(reviewId, name, task, startedAt);
  const runId = Number(inserted.lastInsertRowid);
  try {
    const result = await runProcess(provider.command, provider.args, { input: prompt, timeoutMs: 30 * 60_000 });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${provider.command} exited ${result.exitCode}`);
    database.connection.prepare(`
      UPDATE agent_runs SET status='complete', finished_at=?, output=? WHERE id=?
    `).run(new Date().toISOString(), result.stdout, runId);
    return result.stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    database.connection.prepare(`
      UPDATE agent_runs SET status='failed', finished_at=?, error=? WHERE id=?
    `).run(new Date().toISOString(), message, runId);
    throw error;
  }
}

function getReview(database: BarbarianDatabase, id: string): ReviewRow {
  const row = database.connection.prepare(`
    SELECT id, repository, number, title, simple_summary, url, review_skill, head_sha
    FROM review_queue WHERE id=?
  `).get(id) as ReviewRow | undefined;
  if (!row) throw new Error('Pull request is not in the review queue');
  return row;
}

export async function askAgent(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
  message: string,
  provider?: string,
): Promise<string> {
  const review = getReview(database, reviewId);
  const history = database.connection.prepare(`
    SELECT role, author, content FROM chat_messages WHERE review_id=? ORDER BY id DESC LIMIT 20
  `).all(reviewId).reverse() as Array<{ role: string; author: string; content: string }>;
  const prompt = `You are helping a developer understand a pull request. Be direct and use plain language.

PR: ${review.repository}#${review.number} — ${review.title}
URL: ${review.url}
Known summary: ${review.simple_summary}

Conversation:
${history.map((entry) => `${entry.author}: ${entry.content}`).join('\n')}

Developer: ${message}`;
  return executeAgent(database, config, reviewId, 'chat', prompt, provider);
}

function parseReviewResult(output: string): { findings: number; verdict: string } {
  const match = output.match(/BARBARIAN_RESULT:\s*(\{[^\n]+\})/);
  if (match?.[1]) {
    try {
      const parsed = JSON.parse(match[1]) as { findings?: number; verdict?: string };
      return { findings: Math.max(0, parsed.findings || 0), verdict: parsed.verdict || 'reviewed' };
    } catch { /* fall through to conservative inference */ }
  }
  const count = output.match(/(?:findings?|issues?)\D{0,8}(\d+)/i)?.[1];
  return { findings: count ? Number(count) : 0, verdict: /no issues|looks good|ready/i.test(output) ? 'ready' : 'reviewed' };
}

export async function runReviewAgent(
  database: BarbarianDatabase,
  config: BarbarianConfig,
  reviewId: string,
  provider?: string,
): Promise<void> {
  const review = getReview(database, reviewId);
  database.connection.prepare("UPDATE review_queue SET status='agent_working', updated_at=? WHERE id=?")
    .run(new Date().toISOString(), reviewId);
  recordActivity(database, 'review_started', `Agent started reviewing ${review.repository}#${review.number}`, reviewId);
  const prompt = `Use the ${review.review_skill} skill to review ${review.url} at commit ${review.head_sha}.
Do not modify the pull request branch, create commits, push code, or create another pull request.
Post only confirmed review findings using the skill's normal review-comment rules.
At the very end print one machine-readable line:
BARBARIAN_RESULT: {"findings":<blocking finding count>,"verdict":"ready|issues"}`;
  try {
    const output = await executeAgent(database, config, reviewId, 'code_review', prompt, provider);
    const result = parseReviewResult(output);
    const status = result.findings > 0 ? 'issues_found' : 'ready_to_merge';
    database.connection.prepare(`
      UPDATE review_queue SET status=?, findings_count=?, last_reviewed_sha=head_sha, updated_at=? WHERE id=?
    `).run(status, result.findings, new Date().toISOString(), reviewId);
    recordActivity(database, 'agent_review_completed', `${review.repository}#${review.number}: ${result.findings} issues`, reviewId, result);
  } catch (error) {
    database.connection.prepare("UPDATE review_queue SET status='unreviewed', updated_at=? WHERE id=?")
      .run(new Date().toISOString(), reviewId);
    throw error;
  }
}
