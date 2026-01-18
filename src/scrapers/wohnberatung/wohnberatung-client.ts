import fs from "node:fs/promises";
import { baseUrl, storageStatePath } from "./config.js";

type StorageStateCookie = {
  name: string;
  value: string;
  domain?: string;
  path?: string;
};

export const loadAuthCookies = async (): Promise<string> => {
  const raw = await fs.readFile(storageStatePath, "utf8");
  const parsed = JSON.parse(raw) as { cookies?: StorageStateCookie[] } | null;
  const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
  const serialized = cookies
    .filter((cookie) => cookie.domain?.includes("wohnberatung-wien.at"))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  return serialized;
};

export const buildWohnberatungUrl = (page: "wohnung" | "projekt", id: string, flag?: string) => {
  const url = new URL(baseUrl);
  url.searchParams.set("page", page);
  url.searchParams.set("id", id);
  if (flag) {
    url.searchParams.set(flag, "true");
  }
  return url.toString();
};

export const fetchWohnberatungHtml = async (url: string, cookieHeader: string) => {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      cookie: cookieHeader,
      "user-agent": "flatfinder",
    },
  });
  const html = await response.text();
  return { response, html };
};
