#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('The bundled service installer currently targets macOS launchd. Run `pnpm start` under your platform service manager elsewhere.');
const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(process.env.HOME, 'Library/LaunchAgents');
const plist = path.join(directory, 'io.barbarian.local.plist');
const logDirectory = path.join(process.env.HOME, 'Library/Caches/Barbarian');
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.barbarian.local</string>
  <key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(root, 'dist/server/index.js'))}</string></array>
  <key>WorkingDirectory</key><string>${escape(root)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${escape(path.join(logDirectory, 'barbarian.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(path.join(logDirectory, 'barbarian-error.log'))}</string>
</dict></plist>\n`;
await Promise.all([mkdir(directory, { recursive: true }), mkdir(logDirectory, { recursive: true })]);
await writeFile(plist, document, { mode: 0o600 });
await exec('launchctl', ['bootout', `gui/${process.getuid()}/io.barbarian.local`]).catch(() => undefined);
await exec('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist]);
console.log(`Installed and started ${plist}. Barbarian will resume after login and wake.`);
