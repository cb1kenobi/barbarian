export const suppressResolvedStorageKey = 'barbarian.suppressResolvedFindings';

export function visibleFindings(findings = [], suppressResolved = false) {
  return suppressResolved ? findings.filter((finding) => !finding.resolved) : findings;
}

export async function rememberSuppressResolved(value, storage) {
  const suppressResolved = value === true;
  try { await storage.set({ [suppressResolvedStorageKey]: suppressResolved }); }
  catch {}
  return suppressResolved;
}

export async function restoreSuppressResolved(storage) {
  try {
    const stored = await storage.get(suppressResolvedStorageKey);
    return stored?.[suppressResolvedStorageKey] === true;
  } catch {
    return false;
  }
}
