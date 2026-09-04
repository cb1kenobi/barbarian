import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { BarbarianDatabase } from './database.js';
import { ConfigStore, envPath, serverAddress } from './config.js';
import { createApp, type MonitorRuntime } from './app.js';
import { synchronize } from './sync.js';
import { cleanupCompletedWorkspaces } from './workspaces.js';
import { acquireInstanceLock } from './instance-lock.js';
import { AgentRuntime } from './agent-runtime.js';
import { ReviewDispatcher } from './dispatcher.js';

const currentPath = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
for (const candidate of [
  path.join(os.homedir(), '.local/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  path.dirname(process.execPath),
]) {
  if (!currentPath.includes(candidate)) currentPath.push(candidate);
}
process.env.PATH = currentPath.join(path.delimiter);

const configStore = await ConfigStore.load();
dotenv.config({ path: envPath });
const startupConfig = configStore.get();
const instanceLock = await acquireInstanceLock();
const database = new BarbarianDatabase();
const monitorRuntime: MonitorRuntime = { nextSyncAt: null };
const runtime = new AgentRuntime(startupConfig.agents.maxConcurrent);
let appLogger: { error(error: unknown, message?: string): void } | undefined;
const dispatcher = new ReviewDispatcher(database, () => configStore.get(), runtime, {
  error(error, message) {
    if (appLogger) appLogger.error(error, message);
    else console.error(message || 'review dispatcher failed', error);
  },
});
const app = await createApp(database, configStore, monitorRuntime, {
  runtime,
  dispatcher,
  onConfigUpdated(previous, next) {
    if (previous.monitor.intervalMinutes === next.monitor.intervalMinutes) return;
    scheduleNextMonitorTick();
  },
  onManualSyncStarted() {
    pauseMonitorTimer();
  },
  onManualSyncFinished() {
    resumeMonitorTimer();
  },
});
appLogger = app.log;
const address = serverAddress(startupConfig);

let timer: NodeJS.Timeout | undefined;
let manualSyncsInProgress = 0;
function pauseMonitorTimer(): void {
  manualSyncsInProgress += 1;
  if (timer) clearTimeout(timer);
  timer = undefined;
  monitorRuntime.nextSyncAt = null;
}

function resumeMonitorTimer(): void {
  manualSyncsInProgress = Math.max(0, manualSyncsInProgress - 1);
  if (manualSyncsInProgress === 0) scheduleNextMonitorTick();
}

function scheduleNextMonitorTick(): void {
  if (timer) clearTimeout(timer);
  if (manualSyncsInProgress > 0) {
    timer = undefined;
    monitorRuntime.nextSyncAt = null;
    return;
  }
  const config = configStore.get();
  const delay = config.monitor.intervalMinutes * 60_000;
  monitorRuntime.nextSyncAt = new Date(Date.now() + delay).toISOString();
  timer = setTimeout(monitorTick, delay);
}

async function monitorTick(): Promise<void> {
  const config = configStore.get();
  monitorRuntime.nextSyncAt = null;
  try {
    await synchronize(database, config);
    if (config.review.autoCleanup) await cleanupCompletedWorkspaces(database, config);
    await dispatcher.pump();
  } catch (error) {
    app.log.error(error, 'monitor sweep failed; state is preserved for the next sweep');
  } finally {
    scheduleNextMonitorTick();
  }
}

dispatcher.recoverInterruptedRuns();
await app.listen(address);
app.log.info(`Barbarian is listening at http://${address.host}:${address.port}`);
if (startupConfig.monitor.runOnStartup) void monitorTick();
else {
  void dispatcher.pump();
  scheduleNextMonitorTick();
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'stopping Barbarian');
  if (timer) clearTimeout(timer);
  dispatcher.stop();
  try {
    await runtime.shutdown();
    await app.close();
  } finally {
    database.close();
    await instanceLock.release();
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (error) => app.log.error(error, 'unhandled rejection'));
