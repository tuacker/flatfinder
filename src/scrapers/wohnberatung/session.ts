import { chromium, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import {
  browserSlowMoMs,
  loginHeadless,
  loginTimeoutMs,
  loginUrl,
  storageStatePath,
  suchprofilUrl,
} from "./config.js";

const resolvedStorageStatePath = path.resolve(storageStatePath);

const ensureDir = async () => {
  await fs.mkdir(path.dirname(resolvedStorageStatePath), { recursive: true });
};

const isLoginPage = async (page: Page) => {
  return (await page.locator("form#loginform").count()) > 0;
};

const slowMo = browserSlowMoMs > 0 ? browserSlowMoMs : undefined;

export const loginAndSaveState = async () => {
  await ensureDir();

  const browser = await chromium.launch({ headless: loginHeadless, slowMo });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  console.log("Manual login: please sign in in the opened browser window.");
  console.log("Waiting for login to complete...");

  await page.waitForFunction(() => !document.querySelector("form#loginform"), null, {
    timeout: loginTimeoutMs,
  });

  await page.goto(suchprofilUrl, { waitUntil: "domcontentloaded" });

  if (await isLoginPage(page)) {
    await browser.close();
    throw new Error("Login failed. Please retry the manual login.");
  }

  await context.storageState({ path: resolvedStorageStatePath });
  await browser.close();
};
