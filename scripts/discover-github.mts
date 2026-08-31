import 'dotenv/config';
import { loadConfig } from '../apps/server/src/config.ts';
import { discoverGithub } from '../apps/server/src/github.ts';

const result = await discoverGithub(await loadConfig());
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
