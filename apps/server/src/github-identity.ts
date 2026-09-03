import type { BarbarianDatabase } from './database.js';

const metadataKey = 'authenticated_github_login';

export function storeAuthenticatedGithubLogin(database: BarbarianDatabase, login: string): void {
  const value = login.trim();
  if (!value) return;
  database.connection.prepare(`
    INSERT INTO app_metadata(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(metadataKey, value);
}

export function authenticatedGithubLogin(database: BarbarianDatabase, configured = ''): string {
  const explicit = configured.trim();
  if (explicit) return explicit;
  const stored = database.connection.prepare('SELECT value FROM app_metadata WHERE key=?')
    .get(metadataKey) as { value: string } | undefined;
  return stored?.value.trim() || '';
}
