import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import { browserHeadless, browserSlowMoMs, loginHeadless, loginTimeoutMs } from "./config.js";
import { LOGIN_URL, SUCHPROFIL_URL, STORAGE_STATE_PATH } from "./constants.js";

const storageStatePath = path.resolve(STORAGE_STATE_PATH);

const ensureDir = async () => {
  await fs.mkdir(path.dirname(storageStatePath), { recursive: true });
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

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("Manual login: please sign in in the opened browser window.");
  console.log("Waiting for login to complete...");

  await page.waitForFunction(() => !document.querySelector("form#loginform"), null, {
    timeout: loginTimeoutMs,
  });

  await page.goto(SUCHPROFIL_URL, { waitUntil: "domcontentloaded" });

  if (await isLoginPage(page)) {
    await browser.close();
    throw new Error("Login failed. Please retry the manual login.");
  }

  await context.storageState({ path: storageStatePath });
  await browser.close();
};

export const createAuthenticatedContext = async (): Promise<{
  browser: Browser;
  context: BrowserContext;
  page: Page;
}> => {
  const storageExists = await fs
    .access(storageStatePath)
    .then(() => true)
    .catch(() => false);

  if (!storageExists) {
    throw new Error(
      "Missing storage state. Run `npm run scrape:wohnberatung:login` to save cookies.",
    );
  }

  const browser = await chromium.launch({ headless: browserHeadless, slowMo });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  await page.goto(SUCHPROFIL_URL, { waitUntil: "domcontentloaded" });

  if (await isLoginPage(page)) {
    await browser.close();
    throw new Error("Login required. Run `npm run scrape:wohnberatung:login`.");
  }

  return { browser, context, page };
};
