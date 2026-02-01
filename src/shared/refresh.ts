export const scheduleNextRefresh = (currentMs: number, intervalMs: number) => {
  const base = Number.isFinite(currentMs) && currentMs > 0 ? currentMs : Date.now();
  return base + intervalMs;
};

export const formatRefreshLabel = (nextAtMs: number, nowMs: number) => {
  if (!Number.isFinite(nextAtMs)) return "soon";
  const diffMs = nextAtMs - nowMs;
  if (Number.isNaN(diffMs)) return "soon";
  if (diffMs <= 0) return "now";
  if (diffMs < 60_000) return `${Math.ceil(diffMs / 1000)}s`;
  return `${Math.ceil(diffMs / 60_000)}m`;
};
