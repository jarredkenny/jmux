import { appendFileSync, mkdirSync, existsSync, statSync, renameSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const logDir = resolve(homedir(), ".config", "jmux");
const logPath = resolve(logDir, "jmux.log");
const MAX_LOG_BYTES = 512 * 1024; // 512 KB

let ensured = false;

function ensureDir(): void {
  if (ensured) return;
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  ensured = true;
}

export function logError(tag: string, msg: string): void {
  try {
    ensureDir();
    if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
      renameSync(logPath, logPath + ".old");
    }
    const ts = new Date().toISOString();
    appendFileSync(logPath, `${ts} [${tag}] ${msg}\n`);
  } catch {}
}
