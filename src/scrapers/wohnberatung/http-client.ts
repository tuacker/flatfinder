import fs from "node:fs/promises";
import { STORAGE_STATE_PATH } from "./constants.js";

export type HttpClient = {
  fetchHtml: (url: string, options?: RequestInit) => Promise<string>;
  download: (url: string, options?: RequestInit) => Promise<Buffer | null>;
};

type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
};

type StorageState = {
  cookies: StoredCookie[];
};

const isCookieForHost = (cookie: StoredCookie, host: string) => {
  const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
  return host === domain || host.endsWith(`.${domain}`);
};

const buildCookieHeader = async (url: string) => {
  const data = await fs.readFile(STORAGE_STATE_PATH, "utf8");
  const state = JSON.parse(data) as StorageState;
  const host = new URL(url).hostname;
  const cookies = state.cookies
    .filter((cookie) => isCookieForHost(cookie, host))
    .map((cookie) => `${cookie.name}=${cookie.value}`);
  return cookies.join("; ");
};

export const createHttpClient = async (baseUrl: string): Promise<HttpClient> => {
  const cookieHeader = await buildCookieHeader(baseUrl);

  const buildHeaders = (extra?: HeadersInit) => {
    const headers = new Headers(extra);
    headers.set("cookie", cookieHeader);
    headers.set("user-agent", "flatfinder/1.0");
    return headers;
  };

  const fetchHtml = async (url: string, options: RequestInit = {}) => {
    const response = await fetch(url, {
      redirect: "follow",
      ...options,
      headers: buildHeaders(options.headers),
    });

    if (!response.ok) {
      throw new Error(`Request failed (${response.status}) ${url}`);
    }

    return response.text();
  };

  const download = async (url: string, options: RequestInit = {}) => {
    const response = await fetch(url, {
      redirect: "follow",
      ...options,
      headers: buildHeaders(options.headers),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.arrayBuffer();
    return Buffer.from(data);
  };

  return { fetchHtml, download };
};
