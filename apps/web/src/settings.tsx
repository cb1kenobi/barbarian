import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { normalizeWeapon, weaponAssetPath, weaponFaviconPath, weaponOptions, type Weapon } from './weapons';

export type Theme = 'light' | 'dark' | 'slayer';
export type FontSize = 'small' | 'normal';
export type AgentEffort = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface AppearanceConfig { theme: Theme; fontSize: FontSize; weapon: Weapon }
interface AgentSelectionSettings { provider: string; model: string; effort: AgentEffort }
export interface RepositoryConfig {
  name: string;
  priority: number;
  watchIssues: boolean;
  watchPullRequests: boolean;
  reviewSkill: string;
  labels: Record<string, number>;
}
export interface SettingsConfig {
  profile: { name: string; reviewName: string; timezone: string; githubLogin: string };
  appearance: AppearanceConfig;
  monitor: { intervalMinutes: number; runOnStartup: boolean; includeDraftPullRequests: boolean };
  repositories: RepositoryConfig[];
  review: { requestedReviewer: string; fallbackTeams: string[]; autoCleanup: boolean };
  agents: {
    codeReview: AgentSelectionSettings;
    chat: AgentSelectionSettings;
    autoReview: boolean;
    maxConcurrent: number;
    maxAutomaticAttempts: number;
    retryBaseMinutes: number;
    maxRunsPerPullRequestPerHour: number;
  };
  statusUpdate: { enabled: boolean; workdays: string[]; daysOff: string[] };
}
interface AdvancedSettings {
  workspaceRoot: string;
  linear: { enabled: boolean; configured: boolean };
  providers: Array<{
    name: string;
    supportsModel: boolean;
    supportsEffort: boolean;
    supportsModelDiscovery: boolean;
    models: Array<{ id: string; name: string; isDefault: boolean }>;
    defaultModel: string | null;
    error?: string;
  }>;
}

interface EditableRepository extends Omit<RepositoryConfig, 'labels'> { id: string; labelsText: string }
interface SettingsDraft extends Omit<SettingsConfig, 'repositories'> {
  repositories: EditableRepository[];
}

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const effortLevels: AgentEffort[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
let localId = 0;
const nextId = () => `settings-${localId += 1}`;

export function applyAppearance(appearance: AppearanceConfig): void {
  const weapon = normalizeWeapon(appearance.weapon);
  document.documentElement.dataset.theme = appearance.theme;
  document.documentElement.dataset.fontSize = appearance.fontSize;
  document.documentElement.dataset.weapon = weapon;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', appearance.theme === 'light' ? '#f4f5f0' : '#11120f');
  document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.setAttribute('href', weaponFaviconPath(weapon));
  try { localStorage.setItem('barbarian.appearance', JSON.stringify({ ...appearance, weapon })); } catch {}
}

export function timezoneOptions(current?: string): string[] {
  const supportedValuesOf = (Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  }).supportedValuesOf;
  const values = supportedValuesOf ? supportedValuesOf('timeZone') : ['UTC'];
  return current && !values.includes(current) ? [current, ...values] : values;
}

export function formatLabels(labels: Record<string, number>): string {
  return Object.entries(labels).map(([name, weight]) => `${name}: ${weight}`).join('\n');
}

export function parseLabels(value: string): Record<string, number> {
  const labels: Record<string, number> = {};
  for (const [index, source] of value.split('\n').entries()) {
    const line = source.trim();
    if (!line) continue;
    const match = line.match(/^(.+?):\s*(-?\d+)$/);
    if (!match) throw new Error(`Label weight line ${index + 1} must look like “security: 80”`);
    labels[match[1]!.trim()] = Number(match[2]);
  }
  return labels;
}

export function splitItems(value: string): string[] {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function toDraft(config: SettingsConfig): SettingsDraft {
  return {
    ...structuredClone(config),
    repositories: config.repositories.map((repository) => ({
      ...repository, id: nextId(), labelsText: formatLabels(repository.labels),
    })),
  };
}

function fromDraft(draft: SettingsDraft): SettingsConfig {
  return {
    ...structuredClone(draft),
    repositories: draft.repositories.map(({ id: _id, labelsText, ...repository }) => ({
      ...repository,
      name: repository.name.trim(),
      reviewSkill: repository.reviewSkill.trim(),
      labels: parseLabels(labelsText),
    })),
  } as SettingsConfig;
}

function messageFromResponse(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const candidate = body as { error?: string; issues?: Array<{ path?: string; message?: string }> };
  const issue = candidate.issues?.[0];
  return issue ? `${issue.path || 'config'}: ${issue.message || 'invalid value'}` : candidate.error || fallback;
}

function AgentPicker({
  selection, providers, modelsLoading, onChange,
}: {
  selection: AgentSelectionSettings;
  providers: AdvancedSettings['providers'];
  modelsLoading: boolean;
  onChange: (selection: AgentSelectionSettings) => void;
}) {
  const provider = providers.find((candidate) => candidate.name === selection.provider);
  const detectedModels = provider?.models || [];
  const modelDiscoveryLoading = Boolean(modelsLoading && provider?.supportsModelDiscovery && detectedModels.length === 0);
  const selectedModelIsDetected = !selection.model || detectedModels.some((model) => model.id === selection.model);
  const defaultName = detectedModels.find((model) => model.id === provider?.defaultModel)?.name || provider?.defaultModel;
  return <div className="settings-grid three agent-picker">
    <label><span>Provider</span><select required value={selection.provider} onChange={(event) => onChange({ provider: event.target.value, model: '', effort: '' })}>
      {!providers.some((candidate) => candidate.name === selection.provider) && <option value={selection.provider}>{selection.provider}</option>}
      {providers.map((candidate) => <option key={candidate.name} value={candidate.name}>{candidate.name}</option>)}
    </select></label>
    <label><span>Model <small>{detectedModels.length ? `${detectedModels.length} detected` : modelDiscoveryLoading ? 'loading' : provider?.error ? 'discovery failed' : provider?.supportsModel ? defaultName ? `CLI default: ${defaultName}` : 'blank uses CLI default' : 'not supported'}</small></span>{modelDiscoveryLoading
      ? <div className="model-discovery-loading" role="status"><span aria-hidden="true" />Detecting models…</div>
      : detectedModels.length ? <select value={selection.model} onChange={(event) => onChange({ ...selection, model: event.target.value })}>
        <option value="">{defaultName ? `CLI default — ${defaultName}` : 'CLI default'}</option>
        {!selectedModelIsDetected && <option value={selection.model}>{selection.model}</option>}
        {detectedModels.map((model) => <option key={model.id} value={model.id}>{model.name}{model.isDefault ? ' — default' : ''}</option>)}
      </select>
      : <input disabled={!provider?.supportsModel} placeholder="CLI default" value={selection.model} onChange={(event) => onChange({ ...selection, model: event.target.value })} />}</label>
    <label><span>Effort <small>{provider?.supportsEffort ? 'reasoning depth' : 'not supported'}</small></span><select className={!provider?.supportsEffort ? 'unsupported-field' : undefined} disabled={!provider?.supportsEffort} value={provider?.supportsEffort ? selection.effort : ''} onChange={(event) => onChange({ ...selection, effort: event.target.value as AgentEffort })}>{effortLevels.map((effort) => <option key={effort || 'default'} value={effort}>{effort || 'CLI default'}</option>)}</select></label>
  </div>;
}

export function SettingsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [configFile, setConfigFile] = useState('config/barbarian.yaml');
  const [revision, setRevision] = useState('');
  const [warning, setWarning] = useState('');
  const [advanced, setAdvanced] = useState<AdvancedSettings | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const originalAppearance = useRef<AppearanceConfig | null>(null);
  const saved = useRef(false);
  const savingRef = useRef(false);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetch('/api/settings', { signal: controller.signal }).then(async (response) => {
      const body = await response.json() as { config?: SettingsConfig; advanced?: AdvancedSettings; configFile?: string; revision?: string; warning?: string | null };
      if (!response.ok || !body.config) throw new Error(messageFromResponse(body, response.statusText));
      originalAppearance.current = body.config.appearance;
      setConfigFile(body.configFile || 'config/barbarian.yaml');
      setRevision(body.revision || '');
      setWarning(body.warning || '');
      setAdvanced(body.advanced || null);
      setDraft(toDraft(body.config));
      setModelsLoading(true);
      void fetch('/api/settings/agent-models', { signal: controller.signal }).then(async (modelsResponse) => {
        const modelsBody = await modelsResponse.json() as {
          providers?: Array<Pick<AdvancedSettings['providers'][number], 'name' | 'models' | 'defaultModel' | 'error'>>;
        };
        if (!modelsResponse.ok) throw new Error(modelsResponse.statusText);
        setAdvanced((current) => current ? {
          ...current,
          providers: current.providers.map((provider) => ({
            ...provider,
            ...modelsBody.providers?.find((candidate) => candidate.name === provider.name),
          })),
        } : current);
      }).catch(() => undefined).finally(() => { if (active) setModelsLoading(false); });
    }).catch((caught) => {
      if ((caught as Error).name !== 'AbortError') setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { active = false; controller.abort(); };
  }, []);

  useEffect(() => {
    if (draft) applyAppearance(draft.appearance);
  }, [draft?.appearance]);

  useEffect(() => {
    closeButton.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !savingRef.current) onCloseRef.current(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      if (!saved.current && originalAppearance.current) applyAppearance(originalAppearance.current);
    };
  }, []);

  const timezoneOptionNodes = useMemo(
    () => timezoneOptions(draft?.profile.timezone).map((timezone) => <option key={timezone}>{timezone}</option>),
    [draft?.profile.timezone],
  );
  const updateRepository = (index: number, patch: Partial<EditableRepository>) => setDraft((current) => current && ({
    ...current,
    repositories: current.repositories.map((repository, candidate) => candidate === index ? { ...repository, ...patch } : repository),
  }));
  const removeRepository = (index: number) => setDraft((current) => current && ({
    ...current, repositories: current.repositories.filter((_, candidate) => candidate !== index),
  }));
  const addRepository = () => setDraft((current) => current && ({
    ...current,
    repositories: [...current.repositories, {
      id: nextId(), name: '', priority: 0, watchIssues: true, watchPullRequests: true,
      reviewSkill: 'cb1-code-review', labelsText: '',
    }],
  }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const config = fromDraft(draft);
      const response = await fetch('/api/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revision, config }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(messageFromResponse(body, response.statusText));
      saved.current = true;
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return <div className="modal-backdrop settings-backdrop" onMouseDown={() => { if (!saving) onClose(); }}>
    <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
      <button ref={closeButton} type="button" className="drawer-close" onClick={onClose} disabled={saving} aria-label="Close settings">×</button>
      <header className="settings-header"><div><span className="section-label">CONFIGURATION</span><h2 id="settings-title">Settings</h2><p>Changes are saved to <code>{configFile}</code>. Secrets in <code>.env</code> are never shown here.</p>{warning && <p className="settings-warning">{warning}</p>}</div></header>
      {!draft ? <div className="settings-loading">{error || 'Loading configuration…'}</div> : <form onSubmit={(event) => void submit(event)}>
        <div className="settings-body">
          <fieldset className="settings-section"><legend>Profile</legend><div className="settings-description-list">
            <div className="settings-description-row">
              <label><span>Your Name</span><input required aria-describedby="profile-name-description" value={draft.profile.name} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, name: event.target.value } })} /></label>
              <p id="profile-name-description">Display name used in the dashboard greeting and other personalized text.</p>
            </div>
            <div className="settings-description-row">
              <label><span>GitHub login</span><input aria-describedby="profile-github-description" value={draft.profile.githubLogin} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, githubLogin: event.target.value } })} /></label>
              <p id="profile-github-description">Identifies your assigned issues, reviews, approvals, and authored PRs. Leave blank to use the account authenticated by <code>gh</code>.</p>
            </div>
            <div className="settings-description-row">
              <label><span>Timezone</span><select aria-describedby="profile-timezone-description" value={draft.profile.timezone} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, timezone: event.target.value } })}>{timezoneOptionNodes}</select></label>
              <p id="profile-timezone-description">Controls displayed timestamps, workday boundaries, and status-update dates.</p>
            </div>
          </div></fieldset>

          <fieldset className="settings-section"><legend>Appearance</legend><div className="choice-groups">
            <div><span className="field-label">Theme</span><div className="choice-row">{(['light', 'dark', 'slayer'] as Theme[]).map((theme) => <label className={`choice-card theme-${theme}`} key={theme}><input type="radio" name="theme" checked={draft.appearance.theme === theme} onChange={() => setDraft({ ...draft, appearance: { ...draft.appearance, theme } })} /><span>{theme[0]!.toUpperCase() + theme.slice(1)}</span></label>)}</div></div>
            <div><span className="field-label">Font size</span><div className="choice-row">{(['small', 'normal'] as FontSize[]).map((fontSize) => <label className="choice-card" key={fontSize}><input type="radio" name="font-size" checked={draft.appearance.fontSize === fontSize} onChange={() => setDraft({ ...draft, appearance: { ...draft.appearance, fontSize } })} /><span>{fontSize[0]!.toUpperCase() + fontSize.slice(1)}</span></label>)}</div></div>
            <div className="weapon-choice-group"><span className="field-label">Weapon</span><div className="weapon-choice-row">{weaponOptions.map((weapon) => <label className="choice-card weapon-choice" key={weapon.id} title={weapon.label}><input type="radio" name="weapon" checked={draft.appearance.weapon === weapon.id} onChange={() => setDraft({ ...draft, appearance: { ...draft.appearance, weapon: weapon.id } })} /><i className="weapon-option-mark" aria-hidden="true" style={{ '--weapon-option': `url("${weaponAssetPath(weapon.id)}")` } as CSSProperties} /><span>{weapon.label}</span></label>)}</div></div>
          </div></fieldset>

          <fieldset className="settings-section"><legend>Monitoring</legend><div className="settings-grid three">
            <label><span>Interval (minutes)</span><input type="number" min="20" required value={draft.monitor.intervalMinutes} onChange={(event) => setDraft({ ...draft, monitor: { ...draft.monitor, intervalMinutes: Number(event.target.value) } })} /></label>
            <label className="check-field"><input type="checkbox" checked={draft.monitor.runOnStartup} onChange={(event) => setDraft({ ...draft, monitor: { ...draft.monitor, runOnStartup: event.target.checked } })} /><span>Run on startup</span></label>
            <label className="check-field"><input type="checkbox" checked={draft.monitor.includeDraftPullRequests} onChange={(event) => setDraft({ ...draft, monitor: { ...draft.monitor, includeDraftPullRequests: event.target.checked } })} /><span>Include draft PRs</span></label>
          </div></fieldset>

          <fieldset className="settings-section repositories-section"><legend>Repositories</legend>
            <div className="settings-list">{draft.repositories.map((repository, index) => <article className="settings-card" key={repository.id}>
              <div className="settings-card-head"><strong>Repository {index + 1}</strong><button type="button" className="danger-text" onClick={() => removeRepository(index)}>Remove</button></div>
              <div className="settings-grid repo-fields">
                <label className="wide"><span>GitHub Repository (owner/name)</span><input required placeholder="owner/name" value={repository.name} onChange={(event) => updateRepository(index, { name: event.target.value })} /></label>
                <label className="repo-priority"><span>Priority</span><input type="number" value={repository.priority} onChange={(event) => updateRepository(index, { priority: Number(event.target.value) })} /></label>
                <label><span>Review skill</span><input required value={repository.reviewSkill} onChange={(event) => updateRepository(index, { reviewSkill: event.target.value })} /></label>
                <div className="repo-watch-fields">
                  <label className="check-field"><input type="checkbox" checked={repository.watchIssues} onChange={(event) => updateRepository(index, { watchIssues: event.target.checked })} /><span>Watch issues</span></label>
                  <label className="check-field"><input type="checkbox" checked={repository.watchPullRequests} onChange={(event) => updateRepository(index, { watchPullRequests: event.target.checked })} /><span>Watch pull requests</span></label>
                </div>
                <label className="wide"><span>Label weights <small>one “label: weight” per line</small></span><textarea rows={3} placeholder={'security: 80\nregression: 60'} value={repository.labelsText} onChange={(event) => updateRepository(index, { labelsText: event.target.value })} /></label>
              </div>
            </article>)}</div>
            <button type="button" className="add-button" onClick={addRepository}>＋ Add repository</button>
          </fieldset>

          <fieldset className="settings-section"><legend>Review behavior</legend><div className="settings-description-list">
            <div className="settings-description-row">
              <label><span>Reviewer Name</span><input aria-describedby="reviewer-name-description" placeholder="Optional" value={draft.profile.reviewName} onChange={(event) => setDraft({ ...draft, profile: { ...draft.profile, reviewName: event.target.value } })} /></label>
              <p id="reviewer-name-description">Optional attribution for AI review comments, such as “CB1 reviewed a1b2c3d4.” Leave blank to use “Reviewed” without a name.</p>
            </div>
            <div className="settings-description-row">
              <label><span>Requested reviewer</span><input aria-describedby="requested-reviewer-description" value={draft.review.requestedReviewer} onChange={(event) => setDraft({ ...draft, review: { ...draft.review, requestedReviewer: event.target.value } })} /></label>
              <p id="requested-reviewer-description">GitHub login Barbarian treats as the target reviewer. Leave blank to use your profile login.</p>
            </div>
            <div className="settings-description-row">
              <label><span>Fallback teams <small>comma-separated</small></span><input aria-describedby="fallback-teams-description" value={draft.review.fallbackTeams.join(', ')} onChange={(event) => setDraft({ ...draft, review: { ...draft.review, fallbackTeams: splitItems(event.target.value) } })} /></label>
              <p id="fallback-teams-description">Team review requests that enter your queue when no individual reviewer is requested.</p>
            </div>
            <div className="settings-description-row">
              <label><span>Workspace root <small>edit in YAML</small></span><code className="readonly-value">{advanced?.workspaceRoot || 'Not configured'}</code></label>
              <p>Dedicated directory for cached clones and per-PR worktrees created by Prepare locally.</p>
            </div>
            <div className="settings-description-row">
              <label className="check-field"><input type="checkbox" aria-describedby="workspace-cleanup-description" checked={draft.review.autoCleanup} onChange={(event) => setDraft({ ...draft, review: { ...draft.review, autoCleanup: event.target.checked } })} /><span>Clean completed workspaces</span></label>
              <p id="workspace-cleanup-description">Remove prepared PR worktrees after their pull requests are merged or closed.</p>
            </div>
          </div></fieldset>

          <fieldset className="settings-section"><legend>Code Review Agent</legend>
            <p className="settings-section-description">Used for automatic PR reviews, manual PR reviews, and local branch reviews.</p>
            <AgentPicker selection={draft.agents.codeReview} providers={advanced?.providers || []} modelsLoading={modelsLoading} onChange={(codeReview) => setDraft({ ...draft, agents: { ...draft.agents, codeReview } })} />
          </fieldset>

          <fieldset className="settings-section"><legend>Chat Agent</legend>
            <p className="settings-section-description">Used for conversations about pull requests, issues, and local branches.</p>
            <AgentPicker selection={draft.agents.chat} providers={advanced?.providers || []} modelsLoading={modelsLoading} onChange={(chat) => setDraft({ ...draft, agents: { ...draft.agents, chat } })} />
          </fieldset>

          <fieldset className="settings-section"><legend>Agent behavior</legend><div className="settings-grid four">
            <label><span>Max concurrent</span><input type="number" min="1" max="8" value={draft.agents.maxConcurrent} onChange={(event) => setDraft({ ...draft, agents: { ...draft.agents, maxConcurrent: Number(event.target.value) } })} /></label>
            <label><span>Max attempts</span><input type="number" min="1" max="10" value={draft.agents.maxAutomaticAttempts} onChange={(event) => setDraft({ ...draft, agents: { ...draft.agents, maxAutomaticAttempts: Number(event.target.value) } })} /></label>
            <label><span>Runs / PR / hour</span><input type="number" min="1" max="20" value={draft.agents.maxRunsPerPullRequestPerHour} onChange={(event) => setDraft({ ...draft, agents: { ...draft.agents, maxRunsPerPullRequestPerHour: Number(event.target.value) } })} /></label>
            <label><span>Retry base (minutes)</span><input type="number" min="1" max="120" value={draft.agents.retryBaseMinutes} onChange={(event) => setDraft({ ...draft, agents: { ...draft.agents, retryBaseMinutes: Number(event.target.value) } })} /></label>
            <label className="check-field"><input type="checkbox" checked={draft.agents.autoReview} onChange={(event) => setDraft({ ...draft, agents: { ...draft.agents, autoReview: event.target.checked } })} /><span>Automatically review</span></label>
          </div></fieldset>

          <fieldset className="settings-section"><legend>Status updates &amp; Linear</legend><div className="settings-grid two">
            <div><label className="check-field"><input type="checkbox" checked={draft.statusUpdate.enabled} onChange={(event) => setDraft({ ...draft, statusUpdate: { ...draft.statusUpdate, enabled: event.target.checked } })} /><span>Prepare daily status updates</span></label><span className="field-label spaced">Workdays</span><div className="weekday-row">{weekdays.map((day) => <label key={day}><input type="checkbox" checked={draft.statusUpdate.workdays.includes(day)} onChange={(event) => setDraft({ ...draft, statusUpdate: { ...draft.statusUpdate, workdays: event.target.checked ? [...draft.statusUpdate.workdays, day] : draft.statusUpdate.workdays.filter((candidate) => candidate !== day) } })} /><span>{day.slice(0, 3)}</span></label>)}</div><label><span>Days off <small>dates separated by commas or lines</small></span><textarea rows={2} value={draft.statusUpdate.daysOff.join('\n')} onChange={(event) => setDraft({ ...draft, statusUpdate: { ...draft.statusUpdate, daysOff: splitItems(event.target.value) } })} /></label></div>
            <div><span className="field-label">Linear integration <small>edit in YAML</small></span><code className="readonly-value command-value">{advanced?.linear.enabled ? advanced.linear.configured ? 'Enabled and configured' : 'Enabled without a command' : 'Disabled'}</code></div>
          </div></fieldset>
        </div>
        <footer className="settings-footer">{error && <p className="settings-error">{error}</p>}<span /><button type="button" className="muted-button" onClick={onClose} disabled={saving}>Cancel</button><button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save settings'}</button></footer>
      </form>}
    </section>
  </div>;
}
