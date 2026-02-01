export const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const getErrorCode = (error: unknown) => {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof (error as { code?: unknown }).code === "string") {
    return String((error as { code?: unknown }).code);
  }
  if ("cause" in error && error.cause && typeof error.cause === "object") {
    const cause = error.cause as { code?: unknown };
    if (typeof cause.code === "string") return String(cause.code);
  }
  return null;
};

const isAbortError = (error: unknown) => {
  if (!error || typeof error !== "object") return false;
  if ("name" in error && (error as { name?: unknown }).name === "AbortError") return true;
  const message = getErrorMessage(error);
  return message.toLowerCase().includes("aborted");
};

export const isTransientError = (error: unknown) => {
  const message = getErrorMessage(error);
  if (message.includes("Request failed") || message.includes("fetch failed")) return true;
  if (isAbortError(error)) return true;
  const code = getErrorCode(error);
  if (!code) return false;
  return ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"].includes(code);
};
