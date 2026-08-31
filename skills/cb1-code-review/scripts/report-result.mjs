#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input);
const response = await fetch('http://127.0.0.1:4142/api/integrations/review-result', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
});
if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
process.stdout.write(`${await response.text()}\n`);
