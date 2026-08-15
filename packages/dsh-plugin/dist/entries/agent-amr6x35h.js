// ../plugin/src/shared/logger.ts
import * as fs from "node:fs";
import * as path2 from "node:path";

// ../plugin/src/shared/data-path.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ../plugin/src/shared/harness.ts
var currentHarness = "opencode";
var harnessLocked = false;
function setHarness(value) {
  if (harnessLocked && currentHarness !== value) {
    throw new Error(`Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`);
  }
  currentHarness = value;
  harnessLocked = true;
}
function getHarness() {
  return currentHarness;
}

// ../plugin/src/shared/data-path.ts
function getDataDir() {
  return process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share");
}
function getMagicContextTempDir(harness = getHarness()) {
  return path.join(os.tmpdir(), harness, "magic-context");
}
function getMagicContextLogPath(harness = getHarness()) {
  const envPath = process.env.MAGIC_CONTEXT_LOG_PATH?.trim();
  if (envPath)
    return envPath;
  return path.join(getMagicContextTempDir(harness), "magic-context.log");
}
function getProjectMagicContextDir(directory) {
  return path.join(directory, ".cortexkit", "magic-context");
}
var GITIGNORE_GUARD_OPEN = "# >>> cortexkit:magic-context";
var GITIGNORE_GUARD_CLOSE = "# <<< cortexkit:magic-context";
function ensureCortexKitArtifactGitignore(directory) {
  try {
    const cortexKitDir = path.join(directory, ".cortexkit");
    const gitignorePath = path.join(cortexKitDir, ".gitignore");
    let existing = "";
    if (existsSync(gitignorePath)) {
      existing = readFileSync(gitignorePath, "utf8");
      if (existing.includes(GITIGNORE_GUARD_OPEN))
        return;
    }
    const block = `${GITIGNORE_GUARD_OPEN}
magic-context/
${GITIGNORE_GUARD_CLOSE}
`;
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith(`
`);
    const next = existing + (needsLeadingNewline ? `
` : "") + block;
    mkdirSync(cortexKitDir, { recursive: true });
    writeFileSync(gitignorePath, next, "utf8");
  } catch {}
}
function getProjectMagicContextHistorianDir(directory) {
  return path.join(getProjectMagicContextDir(directory), "historian");
}
function getOpenCodeStorageDir() {
  return path.join(getDataDir(), "opencode", "storage");
}
function getMagicContextStorageDir() {
  if (!process.env.XDG_DATA_HOME) {
    const testDataDir = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
    if (testDataDir) {
      return path.join(testDataDir, "cortexkit", "magic-context");
    }
    if (false) {}
  }
  return path.join(getDataDir(), "cortexkit", "magic-context");
}
function getLegacyOpenCodeMagicContextStorageDir() {
  return path.join(getOpenCodeStorageDir(), "plugin", "magic-context");
}

// ../plugin/src/shared/logger.ts
var isTestEnv = false;
var buffer = [];
var flushTimer = null;
var FLUSH_INTERVAL_MS = 500;
var BUFFER_SIZE_LIMIT = 50;
var swallowedWriteCount = 0;
var lastErrorMessage = null;
var lastErrorTime = null;
function recordSwallowedWrite(error) {
  try {
    swallowedWriteCount++;
    lastErrorMessage = error instanceof Error ? error.message : String(error);
    lastErrorTime = new Date().toISOString();
  } catch {}
}
function ensureDir(filePath) {
  fs.mkdirSync(path2.dirname(filePath), { recursive: true });
}
function flush() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (buffer.length === 0)
    return;
  const data = buffer.join("");
  buffer = [];
  try {
    const logFile = getMagicContextLogPath();
    ensureDir(logFile);
    fs.appendFileSync(logFile, data);
  } catch (error) {
    recordSwallowedWrite(error);
  }
}
function scheduleFlush() {
  if (flushTimer)
    return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}
function log(message, data) {
  if (isTestEnv)
    return;
  try {
    const timestamp = new Date().toISOString();
    const serialized = data === undefined ? "" : data instanceof Error ? ` ${data.message}${data.stack ? `
${data.stack}` : ""}` : ` ${JSON.stringify(data)}`;
    buffer.push(`[${timestamp}] ${message}${serialized}
`);
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush();
    } else {
      scheduleFlush();
    }
  } catch {}
}
function sessionLog(sessionId, message, data) {
  log(`[magic-context][${sessionId}] ${message}`, data);
}
if (!isTestEnv) {
  process.on("exit", flush);
}

export { setHarness, getHarness, getDataDir, ensureCortexKitArtifactGitignore, getProjectMagicContextHistorianDir, getMagicContextStorageDir, getLegacyOpenCodeMagicContextStorageDir, log, sessionLog };
