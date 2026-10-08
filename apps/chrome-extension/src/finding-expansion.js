const storageKey = (pr) => `barbarian.findingExpansion:${pr.toLowerCase()}`;

export function createFindingExpansion(storage) {
  const states = new Map();
  const loading = new Map();
  const loaded = new Set();
  const writes = new Map();
  return {
    async load(pr) {
      const key = storageKey(pr);
      if (loaded.has(key)) return;
      if (!loading.has(key)) {
        loading.set(key, (async () => {
          try {
            const stored = (await storage.get(key))?.[key];
            const saved = stored && typeof stored === 'object' && !Array.isArray(stored)
              ? Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === 'boolean')) : {};
            // A user toggle made during hydration takes precedence.
            states.set(key, { ...saved, ...states.get(key) });
            loaded.add(key);
          } catch { /* Keep the in-memory choices if Chrome storage is unavailable. */ }
          finally { loading.delete(key); }
        })());
      }
      await loading.get(key);
    },
    isOpen(pr, detail, fallback) {
      return states.get(storageKey(pr))?.[detail] ?? fallback;
    },
    remember(pr, detail, open) {
      const key = storageKey(pr);
      const state = states.get(key) || {};
      if (state[detail] === open) return writes.get(key) || Promise.resolve();
      states.set(key, { ...state, [detail]: open });
      const write = (writes.get(key) || Promise.resolve()).then(async () => {
        try { await storage.set({ [key]: { ...states.get(key) } }); }
        catch { /* A storage failure must not reset the current panel. */ }
      });
      writes.set(key, write);
      void write.then(() => { if (writes.get(key) === write) writes.delete(key); });
      return write;
    },
  };
}
