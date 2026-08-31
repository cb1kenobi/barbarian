import 'dotenv/config';
import { BarbarianDatabase } from '../apps/server/src/database.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { synchronize } from '../apps/server/src/sync.ts';
import { cleanupCompletedWorkspaces } from '../apps/server/src/workspaces.ts';

const config = await loadConfig();
const database = new BarbarianDatabase();
try {
  const result = await synchronize(database, config);
  const cleaned = config.review.autoCleanup ? await cleanupCompletedWorkspaces(database, config) : 0;
  console.log(JSON.stringify({ issues: result.issues.length, pullRequests: result.pullRequests.length, warnings: result.warnings, cleaned }, null, 2));
} finally {
  database.close();
}
