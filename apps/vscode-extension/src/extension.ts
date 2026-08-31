import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const endpoint = 'http://127.0.0.1:4142';

interface Review { id: string; repository: string; number: number; title: string; simple_summary: string; status: string; author: string; url: string; workspace_path: string | null }

async function gitContext(): Promise<{ remote: string; branch: string }> {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!folder) throw new Error('Open a repository folder first.');
  const [remote, branch] = await Promise.all([
    exec('git', ['remote', 'get-url', 'origin'], { cwd: folder }),
    exec('git', ['branch', '--show-current'], { cwd: folder }),
  ]);
  return { remote: remote.stdout.trim(), branch: branch.stdout.trim() };
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, { ...options, headers: { 'content-type': 'application/json', ...options?.headers } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error || response.statusText);
  return response.json() as Promise<T>;
}

async function currentReviews(): Promise<Review[]> {
  const context = await gitContext();
  const result = await api<{ reviews: Review[] }>(`/api/local/context?remote=${encodeURIComponent(context.remote)}&branch=${encodeURIComponent(context.branch)}`);
  if (result.reviews.length) return result.reviews;
  return (await api<{ reviews: Review[] }>(`/api/local/context?remote=${encodeURIComponent(context.remote)}`)).reviews;
}

async function chooseReview(): Promise<Review | undefined> {
  const reviews = await currentReviews();
  if (!reviews.length) { void vscode.window.showInformationMessage('No active Barbarian review matches this repository.'); return; }
  if (reviews.length === 1) return reviews[0];
  const chosen = await vscode.window.showQuickPick(reviews.map((review) => ({ label: `#${review.number} ${review.title}`, description: review.status, review })));
  return chosen?.review;
}

function escape(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] || character); }

async function openReview(): Promise<void> {
  const review = await chooseReview();
  if (!review) return;
  const panel = vscode.window.createWebviewPanel('barbarianReview', `Barbarian · ${review.repository}#${review.number}`, vscode.ViewColumn.Beside, { enableScripts: true });
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><style>body{padding:24px;background:#12130f;color:#e7e8df;font:13px -apple-system,sans-serif}.label{color:#c6f45d;font:10px ui-monospace;letter-spacing:.1em}h1{font-size:22px}.summary{padding:14px;border-left:2px solid #c6f45d;background:#1b1d18;color:#a4a99c;line-height:1.6}.status{display:inline-block;padding:5px 7px;border:1px solid #52633a;color:#c6f45d;text-transform:uppercase;font:9px ui-monospace}a{color:#c6f45d}</style></head><body><span class="label">${escape(review.repository)} · #${review.number}</span><h1>${escape(review.title)}</h1><p class="summary">In plain English: ${escape(review.simple_summary)}</p><span class="status">${escape(review.status.replaceAll('_', ' '))}</span><p>Author: ${escape(review.author)}</p><p><a href="${escape(review.url)}">Open on GitHub</a> · <a href="${endpoint}/#reviews">Open Barbarian</a></p>${review.workspace_path ? `<p>Prepared at <code>${escape(review.workspace_path)}</code></p>` : ''}</body></html>`;
}

async function sendSelection(): Promise<void> {
  const review = await chooseReview();
  if (!review) return;
  const editor = vscode.window.activeTextEditor;
  const selection = editor?.document.getText(editor.selection).trim();
  const note = await vscode.window.showInputBox({ prompt: 'Add a note for the Barbarian review room', placeHolder: 'Why is this code important?' });
  if (note === undefined) return;
  const location = editor ? `${vscode.workspace.asRelativePath(editor.document.uri)}:${editor.selection.start.line + 1}` : '';
  const content = [note, location && `Local context: ${location}`, selection && `Selected code:\n${selection}`].filter(Boolean).join('\n\n');
  await api(`/api/reviews/${encodeURIComponent(review.id)}/chat`, { method: 'POST', body: JSON.stringify({ message: content, askAgent: false, author: 'VS Code extension' }) });
  void vscode.window.showInformationMessage('Saved to the Barbarian review room.');
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('barbarian.openReview', () => openReview().catch((error) => void vscode.window.showErrorMessage(error.message))),
    vscode.commands.registerCommand('barbarian.sendSelection', () => sendSelection().catch((error) => void vscode.window.showErrorMessage(error.message))),
    vscode.commands.registerCommand('barbarian.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(endpoint))),
  );
}

export function deactivate(): void {}
