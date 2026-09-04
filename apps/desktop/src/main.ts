import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  shell,
  utilityProcess,
  type UtilityProcess,
} from 'electron';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { BarbarianConfig } from '../../server/src/types.js';

const execute = promisify(execFile);
const devUrl = process.argv.find((argument) => argument.startsWith('--dev-url='))?.slice('--dev-url='.length);
app.setName('Barbarian');
app.setPath('userData', path.join(app.getPath('appData'), 'Barbarian'));
app.setPath('sessionData', path.join(app.getPath('home'), 'Library/Caches/Barbarian/Electron'));
let mainWindow: BrowserWindow | undefined;
let serverProcess: UtilityProcess | undefined;
let serverOwned = false;
let stoppingServer = false;
let quitting = false;
let quitAfterShutdown = false;
let bootstrapping = true;
let focusAfterBootstrap = false;
let currentServerUrl = 'http://127.0.0.1:4142';
let registeredShortcut = '';
let restartOperation: Promise<void> | undefined;
const failurePageLoads = new WeakSet<BrowserWindow>();

function resourceRoot(): string {
  return app.getAppPath();
}

function cacheRoot(): string {
  return path.join(app.getPath('home'), 'Library/Caches/Barbarian');
}

async function loadConfig(): Promise<BarbarianConfig> {
  const module = await import('../../server/src/config.js');
  return (await module.ConfigStore.load()).get();
}

function connectUrl(server: BarbarianConfig['server']): string {
  return `http://127.0.0.1:${server.port}`;
}

async function health(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(800) });
    const body = await response.json() as { service?: string };
    return response.ok && body.service === 'barbarian';
  } catch {
    return false;
  }
}

async function waitForServer(url: string, child?: UtilityProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  let childExited = false;
  const onChildExit = () => { childExited = true; };
  child?.once('exit', onChildExit);
  try {
    while (Date.now() < deadline) {
      if (await health(url)) return;
      if (child && (childExited || serverProcess !== child)) throw new Error('The Barbarian server exited before it became ready.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    child?.off('exit', onChildExit);
  }
  throw new Error(`Timed out waiting for Barbarian at ${url}`);
}

async function startServer(): Promise<string> {
  const config = await loadConfig();
  currentServerUrl = connectUrl(config.server);
  if (await health(currentServerUrl)) {
    serverOwned = false;
    return currentServerUrl;
  }

  const entry = path.join(resourceRoot(), 'dist/server/index.js');
  if (!existsSync(entry)) throw new Error(`The packaged server is missing: ${entry}`);
  const child = utilityProcess.fork(entry, [], {
    cwd: resourceRoot(),
    env: {
      ...process.env,
      BARBARIAN_HOME: app.getPath('userData'),
      BARBARIAN_CACHE_HOME: cacheRoot(),
      BARBARIAN_RESOURCE_ROOT: resourceRoot(),
    },
    serviceName: 'Barbarian Server',
    stdio: 'pipe',
  });
  serverProcess = child;
  serverOwned = true;
  let childReady = false;
  child.stdout?.on('data', (chunk) => process.stdout.write(`[server] ${String(chunk)}`));
  child.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${String(chunk)}`));
  child.once('exit', (code) => {
    if (serverProcess !== child) return;
    serverProcess = undefined;
    serverOwned = false;
    if (stoppingServer || quitting || !childReady) return;
    void dialog.showMessageBox({
      type: 'error',
      title: 'Barbarian server stopped',
      message: `The Barbarian server exited unexpectedly${code == null ? '.' : ` with code ${code}.`}`,
      detail: 'Use Barbarian → Restart Server to start it again.',
    });
  });
  await waitForServer(currentServerUrl, child);
  childReady = true;
  return currentServerUrl;
}

async function stopServer(): Promise<void> {
  const child = serverProcess;
  if (!child || !serverOwned) return;
  stoppingServer = true;
  try {
    let exited = false;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      child.once('exit', () => {
        exited = true;
        clearTimeout(timeout);
        resolve();
      });
      if (!child.kill()) {
        clearTimeout(timeout);
        resolve();
      }
    });
    if (!exited && child.pid) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 2_000);
        child.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }
  } finally {
    if (serverProcess === child) serverProcess = undefined;
    serverOwned = false;
    stoppingServer = false;
  }
}

async function loadDashboard(window: BrowserWindow): Promise<void> {
  const url = devUrl || currentServerUrl;
  if (devUrl) await waitForServer(devUrl);
  await window.loadURL(url);
}

function focusWindow(): void {
  if (bootstrapping) {
    focusAfterBootstrap = true;
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  })[character]!);
}

async function loadFailurePage(window: BrowserWindow, message: string): Promise<void> {
  failurePageLoads.add(window);
  try {
    await window.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:40px;background:#11120f;color:#f4f5f0;font:16px system-ui"><h1>Barbarian could not start</h1><pre>${escapeHtml(message)}</pre><p>Use Barbarian → Restart Server to try again.</p></body>`)}`);
  } finally {
    failurePageLoads.delete(window);
  }
}

async function createWindow(options: { showOnReady?: boolean; startupError?: string } = {}): Promise<BrowserWindow> {
  const showOnReady = options.showOnReady !== false;
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'Barbarian',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    backgroundColor: '#11120f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = window;
  window.once('ready-to-show', () => { if (showOnReady) window.show(); });
  window.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  window.on('closed', () => { if (mainWindow === window) mainWindow = undefined; });
  window.webContents.on('will-navigate', (event, url) => {
    if (failurePageLoads.has(window) && url.startsWith('data:text/html,')) return;
    try {
      if (new URL(url).origin === new URL(devUrl || currentServerUrl).origin) return;
    } catch {}
    event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  if (options.startupError) {
    await loadFailurePage(window, options.startupError);
    if (showOnReady) window.show();
    return window;
  }
  try {
    await loadDashboard(window);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await loadFailurePage(window, message);
    if (showOnReady) window.show();
  }
  return window;
}

async function performRestartServer(): Promise<void> {
  if (!serverOwned && await health(currentServerUrl)) {
    throw new Error('Barbarian is connected to an externally managed server. Restart that Node process directly.');
  }
  await stopServer();
  await startServer();
  if (mainWindow && !mainWindow.isDestroyed()) await loadDashboard(mainWindow);
}

function restartServer(): Promise<void> {
  if (!restartOperation) {
    restartOperation = performRestartServer().finally(() => { restartOperation = undefined; });
  }
  return restartOperation;
}

async function installEditorExtension(editor: 'code' | 'cursor'): Promise<void> {
  const vsix = path.join(resourceRoot(), 'dist/extensions/barbarian-vscode-extension.vsix');
  if (!existsSync(vsix)) throw new Error('The packaged VS Code extension is missing.');
  const applications = editor === 'code'
    ? ['/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code', 'code']
    : ['/Applications/Cursor.app/Contents/Resources/app/bin/cursor', 'cursor'];
  let lastError: unknown;
  for (const command of applications) {
    try {
      await execute(command, ['--install-extension', vsix, '--force'], { timeout: 60_000 });
      await dialog.showMessageBox({ type: 'info', message: `Installed the Barbarian extension for ${editor === 'code' ? 'VS Code' : 'Cursor'}.` });
      return;
    } catch (error) { lastError = error; }
  }
  throw lastError instanceof Error ? lastError : new Error(`Could not find the ${editor} command.`);
}

async function syncChromeExtension(showInstructions = true): Promise<void> {
  const source = path.join(resourceRoot(), 'apps/chrome-extension');
  const destination = path.join(app.getPath('userData'), 'extensions/chrome');
  if (!existsSync(source)) throw new Error('The packaged Chrome extension is missing.');
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
  if (!showInstructions) return;
  await shell.showItemInFolder(path.join(destination, 'manifest.json'));
  await dialog.showMessageBox({
    type: 'info',
    title: 'Load the Barbarian Chrome extension',
    message: 'The stable extension folder is ready.',
    detail: `Open chrome://extensions, enable Developer mode, choose Load unpacked, and select:\n\n${destination}`,
  });
}

async function applyPreferences(): Promise<void> {
  const config = await loadConfig();
  if (app.getLoginItemSettings().openAtLogin !== config.desktop.launchAtLogin) {
    app.setLoginItemSettings({ openAtLogin: config.desktop.launchAtLogin });
  }
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = '';
  if (config.desktop.globalShortcut) {
    let registered = false;
    try { registered = globalShortcut.register(config.desktop.globalShortcut, focusWindow); }
    catch {}
    if (registered) registeredShortcut = config.desktop.globalShortcut;
    else {
      void dialog.showMessageBox({
        type: 'warning',
        message: `Barbarian could not register ${config.desktop.globalShortcut}.`,
        detail: 'Another application may already use that shortcut. Choose a different shortcut in Settings or leave it blank to disable it.',
      });
    }
  }
  buildMenu(config.desktop.launchAtLogin);
}

function reportAction(action: () => Promise<void>): void {
  void action().catch((error) => dialog.showMessageBox({
    type: 'error',
    message: error instanceof Error ? error.message : String(error),
  }));
}

function buildMenu(launchAtLogin: boolean): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Barbarian',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Show Barbarian', click: focusWindow },
        { label: 'Restart Server', click: () => reportAction(restartServer) },
        { type: 'separator' },
        { label: 'Launch at Login', type: 'checkbox', checked: launchAtLogin, enabled: false },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
        { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Extensions',
      submenu: [
        { label: 'Install for VS Code…', click: () => reportAction(() => installEditorExtension('code')) },
        { label: 'Install for Cursor…', click: () => reportAction(() => installEditorExtension('cursor')) },
        { type: 'separator' },
        { label: 'Prepare Chrome Extension…', click: () => reportAction(syncChromeExtension) },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('second-instance', focusWindow);
  app.on('activate', focusWindow);
  app.on('before-quit', (event) => {
    if (quitAfterShutdown) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stopServer().finally(() => {
      quitAfterShutdown = true;
      app.quit();
    });
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  ipcMain.handle('barbarian:restart-server', restartServer);
  ipcMain.handle('barbarian:apply-preferences', applyPreferences);
  void app.whenReady().then(async () => {
    process.env.BARBARIAN_HOME = app.getPath('userData');
    process.env.BARBARIAN_CACHE_HOME = cacheRoot();
    process.env.BARBARIAN_RESOURCE_ROOT = resourceRoot();
    buildMenu(false);
    let startupError = '';
    try { await startServer(); }
    catch (error) { startupError = error instanceof Error ? error.message : String(error); }
    try { await applyPreferences(); }
    catch (error) {
      void dialog.showMessageBox({ type: 'warning', message: 'Some desktop preferences could not be applied.', detail: error instanceof Error ? error.message : String(error) });
    }
    void syncChromeExtension(false).catch((error) => console.error('Could not prepare the Chrome extension', error));
    const openedAsHidden = app.getLoginItemSettings().wasOpenedAtLogin;
    await createWindow({ showOnReady: !openedAsHidden || focusAfterBootstrap, ...(startupError ? { startupError } : {}) });
    bootstrapping = false;
  }).catch((error) => {
    bootstrapping = false;
    void dialog.showErrorBox('Barbarian could not start', error instanceof Error ? error.stack || error.message : String(error));
  });
}
