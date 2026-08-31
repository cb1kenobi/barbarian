import 'dotenv/config';
import { BarbarianDatabase } from './database.js';
import { loadConfig, serverAddress } from './config.js';
import { createApp } from './app.js';
import { synchronize } from './sync.js';
import { cleanupCompletedWorkspaces } from './workspaces.js';

const config = await loadConfig();
const database = new BarbarianDatabase();
const app = await createApp(database, config);
const address = serverAddress();

let timer: NodeJS.Timeout | undefined;
async function monitorTick(): Promise<void> {
  try {
    await synchronize(database, config);
    if (config.review.autoCleanup) await cleanupCompletedWorkspaces(database, config);
  } catch (error) {
    app.log.error(error, 'monitor sweep failed; state is preserved for the next sweep');
  } finally {
    timer = setTimeout(monitorTick, config.monitor.intervalMinutes * 60_000);
  }
}

await app.listen(address);
app.log.info(`Barbarian is listening at http://${address.host}:${address.port}`);
if (config.monitor.runOnStartup) void monitorTick();
else timer = setTimeout(monitorTick, config.monitor.intervalMinutes * 60_000);

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'stopping Barbarian');
  if (timer) clearTimeout(timer);
  await app.close();
  database.close();
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
