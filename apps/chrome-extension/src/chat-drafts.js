export function chatDraftKey(kind, pageKey) {
  return `barbarian.chatDraft:${kind}:${pageKey.toLowerCase()}`;
}

export function createChatDrafts(storage) {
  const entries = new Map();
  const loading = new Map();
  const writes = new Map();
  const unsaved = new Set();
  const snapshot = (key) => entries.get(key) || { value: '', revision: 0 };
  return {
    snapshot,
    async load(key) {
      if (entries.has(key)) return snapshot(key);
      if (!loading.has(key)) {
        loading.set(key, (async () => {
          try {
            const stored = await storage.get(key);
            // Typing while storage is loading takes precedence over the saved value.
            if (!entries.has(key)) entries.set(key, { value: typeof stored?.[key] === 'string' ? stored[key] : '', revision: 0 });
          } finally {
            loading.delete(key);
          }
        })());
      }
      await loading.get(key);
      return snapshot(key);
    },
    set(key, value) {
      const current = snapshot(key);
      if (current.value === value && !unsaved.has(key)) return writes.get(key) || Promise.resolve(true);
      if (current.value !== value) entries.set(key, { value, revision: current.revision + 1 });
      // Serialize writes per conversation so an older save cannot overwrite newer typing.
      const write = (writes.get(key) || Promise.resolve()).then(async () => {
        try {
          if (value) await storage.set({ [key]: value });
          else await storage.remove(key);
          unsaved.delete(key);
          return true;
        } catch { unsaved.add(key); return false; }
      });
      writes.set(key, write);
      void write.then(() => { if (writes.get(key) === write) writes.delete(key); });
      return write;
    },
    clearIfUnchanged(key, sent) {
      const current = snapshot(key);
      if (current.revision !== sent.revision || current.value !== sent.value) return Promise.resolve(false);
      return this.set(key, '');
    },
  };
}
