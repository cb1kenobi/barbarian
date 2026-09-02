#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const target = process.argv[2];
if (!target) throw new Error('Usage: review-context.mjs <owner/repo#number | PR URL>');
const match = target.match(/(?:github\.com\/)?([^/#\s]+)\/([^/#\s]+)(?:\/pull\/|#)(\d+)/);
if (!match) throw new Error(`Could not parse PR target: ${target}`);
const repository = `${match[1]}/${match[2]}`;
const number = Number(match[3]);
const run = async (args) => (await exec('gh', args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
const paginated = async (endpoint) => {
  const pages = JSON.parse(await run(['api', endpoint, '--paginate', '--slurp']));
  return Array.isArray(pages) ? pages.flatMap((page) => Array.isArray(page) ? page : [page]) : [];
};
const metadata = JSON.parse(await run([
  'pr', 'view', String(number), '--repo', repository,
  '--json', 'number,title,body,url,author,headRefOid,headRefName,baseRefName,files,commits,closingIssuesReferences,reviews,reviewDecision,statusCheckRollup',
]));
const expectedHead = metadata.headRefOid;
const [diff, inlineComments, issueComments, reviewEvents] = await Promise.all([
  run(['pr', 'diff', String(number), '--repo', repository]),
  paginated(`repos/${repository}/pulls/${number}/comments?per_page=100`),
  paginated(`repos/${repository}/issues/${number}/comments?per_page=100`),
  paginated(`repos/${repository}/pulls/${number}/reviews?per_page=100`),
]);
const currentHead = JSON.parse(await run([
  'pr', 'view', String(number), '--repo', repository, '--json', 'headRefOid',
])).headRefOid;
if (!expectedHead || currentHead !== expectedHead) {
  throw new Error(`PR head changed while collecting review context (${expectedHead || 'unknown'} -> ${currentHead || 'unknown'}); run again`);
}
const url = `https://github.com/${repository}/pull/${number}`;
const barbarian = await fetch(`http://127.0.0.1:4142/api/browser/context?url=${encodeURIComponent(url)}`)
  .then((response) => response.ok ? response.json() : null)
  .catch(() => null);
process.stdout.write(`${JSON.stringify({ repository, number, metadata, diff, inlineComments, issueComments, reviewEvents, barbarian })}\n`);
