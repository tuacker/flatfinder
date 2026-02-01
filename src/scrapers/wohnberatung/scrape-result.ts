export type ScrapeStatus = "ok" | "skipped" | "auth-error" | "temp-error";

export type ScrapeResult = {
  status: ScrapeStatus;
  updated: boolean;
  message?: string | null;
};
