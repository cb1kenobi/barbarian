const endpoint = 'http://127.0.0.1:4142';
let currentPath = '';
let root;

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
})[character]);

async function api(path, options) {
  const response = await fetch(`${endpoint}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || response.statusText);
  return response.json();
}

function mount() {
  if (root) root.remove();
  root = document.createElement('div');
  root.id = 'barbarian-extension-root';
  const shadow = root.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial}button,textarea,a{font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    .trigger{position:fixed;z-index:2147483646;right:18px;bottom:18px;width:42px;height:42px;border:1px solid #c6f45d;background:#12130f;color:#c6f45d;font:bold 16px ui-monospace;border-radius:3px;box-shadow:0 8px 30px #0008;cursor:pointer}
    .panel{display:none;position:fixed;z-index:2147483647;right:18px;bottom:70px;width:350px;max-height:70vh;overflow:auto;padding:18px;border:1px solid #3a3e34;background:#12130f;color:#e7e8df;box-shadow:0 20px 60px #000a}
    .panel.open{display:block}.label{color:#c6f45d;font:9px ui-monospace;letter-spacing:.12em}.title{margin:7px 0 5px;font:600 15px -apple-system}.summary{color:#92978a;line-height:1.5;font-size:11px}.status{display:inline-block;margin:10px 0;padding:4px 6px;border:1px solid #475533;color:#c6f45d;font:9px ui-monospace;text-transform:uppercase}
    textarea{box-sizing:border-box;width:100%;min-height:72px;margin-top:12px;padding:9px;border:1px solid #383c33;background:#0d0e0c;color:#e7e8df;resize:vertical}.actions{display:flex;gap:7px;margin-top:7px}.actions button,.actions a{padding:8px 10px;border:0;background:#c6f45d;color:#15170f;font-weight:600;text-decoration:none;cursor:pointer}.actions .quiet{border:1px solid #393d34;background:transparent;color:#a5aa9e}.error{color:#ff8f6d;font-size:10px}.empty{color:#777c70;font-size:11px;line-height:1.5}
  </style><button class="trigger" title="Open Barbarian">B</button><section class="panel"><div class="body">Connecting…</div></section>`;
  document.documentElement.append(root);
  const panel = shadow.querySelector('.panel');
  shadow.querySelector('.trigger').addEventListener('click', () => panel.classList.toggle('open'));
  void refresh(shadow);
}

async function refresh(shadow) {
  const body = shadow.querySelector('.body');
  try {
    const context = await api(`/api/browser/context?url=${encodeURIComponent(location.href)}`);
    if (!context.review) {
      body.innerHTML = `<p class="empty">This pull request is not in Barbarian’s queue yet. Run a sync or add its repository to <code>config/barbarian.yaml</code>.</p>`;
      return;
    }
    const review = context.review;
    body.innerHTML = `<span class="label">BARBARIAN REVIEW ROOM</span><h2 class="title">${escapeHtml(review.title)}</h2><p class="summary">${escapeHtml(review.simple_summary)}</p><span class="status">${escapeHtml(review.status.replaceAll('_', ' '))}</span><textarea placeholder="Ask about the PR, or select code on the page and capture it…"></textarea><p class="error"></p><div class="actions"><button class="send">Ask agent</button><button class="quiet capture">Capture selection</button><a class="quiet" href="${endpoint}/#reviews" target="_blank">Dashboard</a></div>`;
    const input = body.querySelector('textarea');
    const error = body.querySelector('.error');
    const send = async (askAgent) => {
      const selection = askAgent ? '' : String(window.getSelection() || '').trim();
      const content = selection ? `${input.value.trim()}\n\nSelected on GitHub:\n${selection}`.trim() : input.value.trim();
      if (!content) { error.textContent = selection ? '' : 'Write a question or select code first.'; return; }
      error.textContent = askAgent ? 'Agent is thinking…' : 'Saving…';
      try {
        await api(`/api/reviews/${encodeURIComponent(review.id)}/chat`, { method: 'POST', body: JSON.stringify({ message: content, askAgent, author: 'GitHub extension' }) });
        input.value = ''; error.textContent = askAgent ? 'Reply saved in Barbarian.' : 'Selection saved.';
      } catch (caught) { error.textContent = caught.message; }
    };
    body.querySelector('.send').addEventListener('click', () => void send(true));
    body.querySelector('.capture').addEventListener('click', () => void send(false));
  } catch (caught) {
    body.innerHTML = `<p class="error">Barbarian is offline: ${escapeHtml(caught.message)}</p><a class="quiet" href="${endpoint}" target="_blank">Open dashboard</a>`;
  }
}

function checkNavigation() {
  if (location.pathname === currentPath) return;
  currentPath = location.pathname;
  if (/^\/[^/]+\/[^/]+\/pull\/\d+/.test(currentPath)) mount();
  else if (root) { root.remove(); root = undefined; }
}

checkNavigation();
new MutationObserver(checkNavigation).observe(document.body, { childList: true, subtree: true });
