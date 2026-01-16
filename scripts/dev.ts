import { spawn } from "node:child_process";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binDir = path.join(rootDir, "node_modules", ".bin");

const tscPath = path.join(binDir, "tsc");
const tsxPath = path.join(binDir, "tsx");

const uiDir = path.join(rootDir, "src", "ui");
const uiCssPath = path.join(uiDir, "styles.css");
const publicDir = path.join(rootDir, "public");
const publicCssPath = path.join(publicDir, "app.css");

const log = (message: string) => {
  console.log(`[dev] ${message}`);
};

const ensureBinary = async (binaryPath: string, label: string) => {
  try {
    await fs.access(binaryPath);
  } catch {
    throw new Error(`Missing ${label} binary. Run "npm install" first.`);
  }
};

const copyCss = async () => {
  try {
    await fs.mkdir(publicDir, { recursive: true });
    await fs.copyFile(uiCssPath, publicCssPath);
  } catch (error) {
    console.warn(
      `[dev] Failed to copy CSS: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const watchCss = () => {
  let timeout: NodeJS.Timeout | undefined;
  const watcher = watch(uiDir, (_event, filename) => {
    if (!filename || filename !== "styles.css") return;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => void copyCss(), 50);
  });
  return watcher;
};

const spawnProcess = (command: string, args: string[], label: string) => {
  log(`Starting ${label}...`);
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", (error) => {
    console.error(`[dev] ${label} failed: ${error.message}`);
  });
  return child;
};

const terminateProcess = (child: ReturnType<typeof spawn>, label: string) => {
  if (child.killed) return;
  log(`Stopping ${label}...`);
  child.kill("SIGINT");
};

const forceKillProcess = (child: ReturnType<typeof spawn>, label: string) => {
  if (child.killed) return;
  log(`Force killing ${label}...`);
  child.kill("SIGKILL");
};

const main = async () => {
  await ensureBinary(tscPath, "tsc");
  await ensureBinary(tsxPath, "tsx");

  await copyCss();
  const cssWatcher = watchCss();

  const tsc = spawnProcess(tscPath, ["-p", "tsconfig.ui.json", "--watch", "--preserveWatchOutput"], "ui build");
  const server = spawnProcess(tsxPath, ["watch", "src/server.ts"], "server");

  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down...");
    cssWatcher.close();
    terminateProcess(tsc, "ui build");
    terminateProcess(server, "server");

    const killTimer = setTimeout(() => {
      forceKillProcess(tsc, "ui build");
      forceKillProcess(server, "server");
    }, 2000);

    setTimeout(() => {
      clearTimeout(killTimer);
      process.exit(0);
    }, 2500);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

void main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
