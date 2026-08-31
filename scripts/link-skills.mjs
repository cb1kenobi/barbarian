#!/usr/bin/env node
import { lstat, mkdir, readdir, readlink, symlink, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const sources = [
  path.resolve(root, '../skills-internal/skills'),
  path.resolve(root, '../cb1-skills/skills'),
  path.join(root, 'skills'),
];
const destinations = [path.join(process.env.HOME, '.agents/skills'), path.join(process.env.HOME, '.claude/skills')];
const selected = new Map();

for (const source of sources) {
  if (!existsSync(source)) { console.warn(`Skipping missing skill source: ${source}`); continue; }
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(path.join(source, entry.name, 'SKILL.md'))) selected.set(entry.name, path.join(source, entry.name));
  }
}

for (const destination of destinations) {
  if (!dryRun) await mkdir(destination, { recursive: true });
  for (const [name, source] of selected) {
    const target = path.join(destination, name);
    if (existsSync(target)) {
      const stat = await lstat(target);
      if (!stat.isSymbolicLink()) { console.warn(`Keeping real directory: ${target}`); continue; }
      const current = path.resolve(path.dirname(target), await readlink(target));
      if (current === source) continue;
      if (!dryRun) await unlink(target);
    }
    console.log(`${dryRun ? 'Would link' : 'Linked'} ${target} -> ${source}`);
    if (!dryRun) await symlink(source, target, 'dir');
  }
}

