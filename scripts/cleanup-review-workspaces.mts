import { BarbarianDatabase } from '../apps/server/src/database.ts';
import { loadConfig } from '../apps/server/src/config.ts';
import { cleanupCompletedWorkspaces } from '../apps/server/src/workspaces.ts';

const database = new BarbarianDatabase();
try {
  console.log(`Cleaned ${await cleanupCompletedWorkspaces(database, await loadConfig())} completed review workspaces.`);
} finally {
  database.close();
}
