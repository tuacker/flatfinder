export type FetchWithTimeoutOptions = RequestInit & { timeoutMs?: number };

export const fetchWithTimeout = async (url: string, options: FetchWithTimeoutOptions = {}) => {
  const { timeoutMs, signal, ...rest } = options;
  const controller = new AbortController();
  const timeout =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const safeJson = async (response: Response): Promise<unknown | null> => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};
