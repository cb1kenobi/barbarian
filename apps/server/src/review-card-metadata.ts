import type { BarbarianDatabase } from './database.js';

export type FindingSeverity = 'high' | 'medium' | 'low';

export interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

export interface ReviewCardMetadata {
  last_agent_review_at: string | null;
  review_round_count: number;
  issue_counts: SeverityCounts;
}

const emptyCounts = (): SeverityCounts => ({ high: 0, medium: 0, low: 0 });

export function findingSeverity(body: string): FindingSeverity {
  const lead = body.slice(0, 400).toLowerCase();
  if (/\bblocker\b|\bcritical\b|\bhigh(?:[- ]priority)?\b|\bp[01]\b/.test(lead)) return 'high';
  if (/\bmedium(?:[- ]priority)?\b|\bwarning\b|\bp2\b/.test(lead)) return 'medium';
  if (/\bnon[- ]blocking\b|\bnit(?:pick)?\b|\bsuggestion\b|\blow(?:[- ]priority)?\b|\bp3\b/.test(lead)) return 'low';
  return 'medium';
}

export function countFindingSeverities(findings: Array<{ body: string }>): SeverityCounts {
  const counts = emptyCounts();
  for (const finding of findings) counts[findingSeverity(finding.body)] += 1;
  return counts;
}

export function reviewCardMetadata(database: BarbarianDatabase): Map<string, ReviewCardMetadata> {
  const metadata = new Map<string, ReviewCardMetadata>();
  const ensure = (reviewId: string): ReviewCardMetadata => {
    let value = metadata.get(reviewId);
    if (!value) {
      value = { last_agent_review_at: null, review_round_count: 0, issue_counts: emptyCounts() };
      metadata.set(reviewId, value);
    }
    return value;
  };

  const runs = database.connection.prepare(`
    SELECT review_id, MAX(finished_at) AS finished_at FROM agent_runs
    WHERE review_id IS NOT NULL AND status='complete' AND task LIKE 'code_review:%'
    GROUP BY review_id
  `).all() as Array<{ review_id: string; finished_at: string }>;
  for (const run of runs) ensure(run.review_id).last_agent_review_at = run.finished_at;

  const rounds = database.connection.prepare(`
    SELECT subject_id AS review_id, COUNT(*) AS total FROM activity_events
    WHERE subject_id IS NOT NULL AND kind='review_started'
    GROUP BY subject_id
  `).all() as Array<{ review_id: string; total: number }>;
  for (const round of rounds) ensure(round.review_id).review_round_count = Number(round.total);

  const findings = database.connection.prepare(`
    SELECT review_id, body FROM review_findings WHERE resolved=0 AND outdated=0
  `).all() as Array<{ review_id: string; body: string }>;
  for (const finding of findings) {
    const counts = ensure(finding.review_id).issue_counts;
    counts[findingSeverity(finding.body)] += 1;
  }
  return metadata;
}
