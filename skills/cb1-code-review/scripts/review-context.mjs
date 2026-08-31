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
const [metadata, diff, inlineComments, issueComments] = await Promise.all([
  run(['pr', 'view', String(number), '--repo', repository, '--json', 'number,title,body,url,author,headRefOid,headRefName,baseRefName,files,commits,closingIssuesReferences,reviews,reviewDecision,statusCheckRollup']),
  run(['pr', 'diff', String(number), '--repo', repository]),
  run(['api', `repos/${repository}/pulls/${number}/comments`, '--paginate']),
  run(['api', `repos/${repository}/issues/${number}/comments`, '--paginate']),
]);
process.stdout.write(`${JSON.stringify({ repository, number, metadata: JSON.parse(metadata), diff, inlineComments: JSON.parse(inlineComments), issueComments: JSON.parse(issueComments) })}\n`);

