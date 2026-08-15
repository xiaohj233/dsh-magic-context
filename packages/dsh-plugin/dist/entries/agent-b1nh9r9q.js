// ../plugin/src/features/magic-context/memory/constants.ts
var V2_MEMORY_CATEGORIES = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING"
];
var PROMOTABLE_CATEGORIES = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING",
  "ARCHITECTURE_DECISIONS",
  "CONFIG_DEFAULTS",
  "USER_PREFERENCES",
  "USER_DIRECTIVES",
  "ENVIRONMENT",
  "WORKFLOW_RULES",
  "KNOWN_ISSUES"
];
var CATEGORY_PRIORITY = [
  "PROJECT_RULES",
  "ARCHITECTURE",
  "CONSTRAINTS",
  "CONFIG_VALUES",
  "NAMING",
  "USER_DIRECTIVES",
  "USER_PREFERENCES",
  "CONFIG_DEFAULTS",
  "ARCHITECTURE_DECISIONS",
  "ENVIRONMENT",
  "WORKFLOW_RULES",
  "KNOWN_ISSUES"
];
var MEMORY_CATEGORY_ORDER_UNKNOWN = 99;
var MEMORY_CATEGORY_ORDER_PRIORITY = CATEGORY_PRIORITY.reduce((acc, category, index) => {
  acc[category] = index;
  return acc;
}, {});
var MEMORY_CATEGORY_ORDER_SQL = `CASE category ${CATEGORY_PRIORITY.map((category, index) => `WHEN '${category}' THEN ${index}`).join(" ")} ELSE ${MEMORY_CATEGORY_ORDER_UNKNOWN} END`;
function getMemoryCategoryOrder(category) {
  return MEMORY_CATEGORY_ORDER_PRIORITY[category] ?? MEMORY_CATEGORY_ORDER_UNKNOWN;
}
var CATEGORY_DEFAULT_TTL = {
  WORKFLOW_RULES: 90 * 24 * 60 * 60 * 1000,
  KNOWN_ISSUES: 30 * 24 * 60 * 60 * 1000
};

// ../plugin/src/features/magic-context/memory/project-identity.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import path3 from "node:path";

// ../plugin/src/shared/logger.ts
import * as fs from "node:fs";
import * as path2 from "node:path";

// ../plugin/src/shared/data-path.ts
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

// ../plugin/src/features/magic-context/memory/project-identity.ts
var GIT_TIMEOUT_MS = 5000;
var TRANSIENT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
var identityCache = new Map;
var linkedGitWorktreeCache = new Map;
var lastKnownGitIdentityCache = new Map;
var directoryFallbackCache = new Map;
var transientFailureCooldown = new Map;
var dubiousOwnershipFallbackDirectories = new Set;
var dubiousOwnershipLoggedDirectories = new Set;
var dubiousOwnershipWarnedDirectories = new Set;
var transientGitIdentityReuseLoggedDirectories = new Set;
var execFileSyncForIdentity = execFileSync;
var userHomeDirectoryForIdentity = () => homedir2();
var nowMs = () => Date.now();

class ProjectIdentityError extends Error {
  errorClass;
  rawDirectory;
  constructor(errorClass, rawDirectory, message, cause) {
    super(message);
    this.name = "ProjectIdentityError";
    this.errorClass = errorClass;
    this.rawDirectory = rawDirectory;
    if (cause) {
      this.cause = cause;
    }
  }
}
function asError(error) {
  return error instanceof Error ? error : undefined;
}
function getErrorCode(error) {
  if (error === null || typeof error !== "object" || !("code" in error)) {
    return;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
function getErrorSignal(error) {
  if (error === null || typeof error !== "object" || !("signal" in error)) {
    return;
  }
  const signal = error.signal;
  return typeof signal === "string" ? signal : undefined;
}
function getErrorKilled(error) {
  if (error === null || typeof error !== "object" || !("killed" in error)) {
    return false;
  }
  return error.killed === true;
}
function getErrorStderr(error) {
  if (error === null || typeof error !== "object" || !("stderr" in error)) {
    return "";
  }
  const stderr = error.stderr;
  if (typeof stderr === "string") {
    return stderr;
  }
  if (Buffer.isBuffer(stderr)) {
    return stderr.toString("utf8");
  }
  return "";
}
function directoryFallback(directory) {
  const canonical = path3.resolve(directory);
  const hash = createHash("md5").update(canonical, "utf8").digest("hex").slice(0, 12);
  return `dir:${hash}`;
}
function assertDirectoryUsable(canonicalDirectory, rawDirectory) {
  try {
    const stat = statSync(canonicalDirectory);
    if (!stat.isDirectory()) {
      throw new ProjectIdentityError("unknown", rawDirectory, `Project path is not a directory: ${canonicalDirectory}`);
    }
  } catch (error) {
    if (error instanceof ProjectIdentityError) {
      throw error;
    }
    const code = getErrorCode(error);
    if (code === "EACCES" || code === "EPERM") {
      throw new ProjectIdentityError("permission_denied", rawDirectory, `Permission denied while accessing project directory: ${canonicalDirectory}`, asError(error));
    }
    throw new ProjectIdentityError("unknown", rawDirectory, `Unable to access project directory: ${canonicalDirectory}`, asError(error));
  }
}
function isGitTimeoutError(error) {
  const code = getErrorCode(error);
  const signal = getErrorSignal(error);
  return code === "ETIMEDOUT" || signal === "SIGTERM" || signal === "SIGKILL" || getErrorKilled(error);
}
function classifyGitError(error, rawDirectory) {
  if (isGitTimeoutError(error)) {
    return new ProjectIdentityError("git_timeout", rawDirectory, `git rev-list timed out after ${GIT_TIMEOUT_MS}ms`, asError(error));
  }
  const code = getErrorCode(error);
  if (code === "ENOENT") {
    return new ProjectIdentityError("git_missing", rawDirectory, "git binary is not available in PATH", asError(error));
  }
  if (code === "EACCES" || code === "EPERM") {
    return new ProjectIdentityError("permission_denied", rawDirectory, "Permission denied while spawning git", asError(error));
  }
  const stderr = getErrorStderr(error).toLowerCase();
  if (stderr.includes("detected dubious ownership")) {
    return new ProjectIdentityError("dubious_ownership", rawDirectory, "git refused to read the repository because it detected dubious ownership", asError(error));
  }
  if (stderr.includes("not a git repository") || stderr.includes("does not have any commits yet") || stderr.includes("ambiguous argument 'head'") || stderr.includes("unknown revision or path")) {
    return new ProjectIdentityError("not_git_repo", rawDirectory, "Directory has no git root commit; caller may use directory fallback", asError(error));
  }
  return new ProjectIdentityError("unknown", rawDirectory, "git rev-list failed while resolving project identity", asError(error));
}
function resolveProjectIdentityStrict(directory) {
  const canonical = path3.resolve(directory);
  const cached = identityCache.get(canonical);
  if (cached !== undefined) {
    return cached;
  }
  assertDirectoryUsable(canonical, directory);
  if (!hasGitDir(canonical)) {
    throw new ProjectIdentityError("not_git_repo", directory, "Directory has no git metadata; caller may use directory fallback");
  }
  let output;
  try {
    output = execFileSyncForIdentity("git", ["rev-list", "--max-parents=0", "HEAD"], {
      cwd: canonical,
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: GIT_TIMEOUT_MS
    });
  } catch (error) {
    throw classifyGitError(error, directory);
  }
  const rootCommit = output.split(`
`).map((line) => line.trim().slice(0, 64)).filter((line) => /^[0-9a-f]{7,64}$/.test(line)).sort()[0];
  if (!rootCommit) {
    throw new ProjectIdentityError("unknown", directory, "git rev-list returned no valid root commit hash");
  }
  const identity = `git:${rootCommit}`;
  identityCache.set(canonical, identity);
  lastKnownGitIdentityCache.set(canonical, identity);
  transientFailureCooldown.delete(canonical);
  dubiousOwnershipFallbackDirectories.delete(canonical);
  transientGitIdentityReuseLoggedDirectories.delete(canonical);
  return identity;
}
function shouldUseDirectoryFallback(error) {
  return error.errorClass !== "permission_denied";
}
function getActiveCooldown(canonical) {
  const until = transientFailureCooldown.get(canonical);
  if (until === undefined)
    return;
  if (nowMs() < until)
    return until;
  transientFailureCooldown.delete(canonical);
  return;
}
function lastKnownGitIdentity(canonical) {
  return lastKnownGitIdentityCache.get(canonical) ?? identityCache.get(canonical);
}
function nearestLastKnownGitIdentity(canonical) {
  const visited = new Set;
  const walk = (start) => {
    let current = start;
    while (!visited.has(current)) {
      visited.add(current);
      const cached = lastKnownGitIdentity(current);
      if (cached !== undefined)
        return { identity: cached, source: current };
      const parent = path3.dirname(current);
      if (parent === current)
        break;
      current = parent;
    }
    return;
  };
  const exactOrAncestor = walk(canonical);
  if (exactOrAncestor)
    return exactOrAncestor;
  try {
    const realCanonical = realpathSync.native(canonical);
    if (realCanonical !== canonical)
      return walk(realCanonical);
  } catch {}
  return;
}
function reuseLastKnownGitIdentity(canonical) {
  const cached = nearestLastKnownGitIdentity(canonical);
  if (cached === undefined)
    return;
  if (!transientGitIdentityReuseLoggedDirectories.has(canonical)) {
    transientGitIdentityReuseLoggedDirectories.add(canonical);
    const sourceNote = cached.source === canonical ? "" : ` from ancestor ${cached.source}`;
    log(`[magic-context] git identity resolution is temporarily unavailable for ${canonical}; reusing the last successful project identity${sourceNote} to avoid splitting project-scoped memory`);
  }
  return cached.identity;
}
function formatDubiousOwnershipWarning(canonical) {
  return `Magic Context: git refused to read ${canonical} (dubious ownership — the repo is owned by a different user). Using a directory-based project identity for now, which keeps memory separate from this repo's normal identity. Fix: git config --global --add safe.directory ${canonical}`;
}
function recordDubiousOwnershipFallback(canonical) {
  dubiousOwnershipFallbackDirectories.add(canonical);
  if (dubiousOwnershipLoggedDirectories.has(canonical))
    return;
  dubiousOwnershipLoggedDirectories.add(canonical);
  log(`[magic-context] ${formatDubiousOwnershipWarning(canonical)}`);
}
function canonicalUserHomeDirectory() {
  const homeDirectory = userHomeDirectoryForIdentity();
  try {
    return realpathSync.native(homeDirectory);
  } catch {
    return homeDirectory;
  }
}
function isUserHomeDirectory(directory) {
  try {
    return realpathSync.native(path3.resolve(directory)) === canonicalUserHomeDirectory();
  } catch {
    return false;
  }
}
function resolveProjectIdentity(directory) {
  const canonical = path3.resolve(directory);
  const cachedFallback = directoryFallbackCache.get(canonical);
  if (cachedFallback !== undefined) {
    if (!hasGitDir(canonical)) {
      return cachedFallback;
    }
    directoryFallbackCache.delete(canonical);
  }
  if (getActiveCooldown(canonical) !== undefined) {
    if (hasGitDir(canonical)) {
      const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
      if (cachedGitIdentity !== undefined) {
        return cachedGitIdentity;
      }
    }
    return directoryFallback(canonical);
  }
  try {
    return resolveProjectIdentityStrict(directory);
  } catch (error) {
    if (error instanceof ProjectIdentityError && shouldUseDirectoryFallback(error)) {
      const fallback = directoryFallback(canonical);
      const hasGitMetadata = hasGitDir(canonical);
      if (!hasGitMetadata) {
        directoryFallbackCache.set(canonical, fallback);
        transientFailureCooldown.delete(canonical);
      } else {
        transientFailureCooldown.set(canonical, nowMs() + TRANSIENT_FAILURE_COOLDOWN_MS);
        const cachedGitIdentity = reuseLastKnownGitIdentity(canonical);
        if (cachedGitIdentity !== undefined) {
          return cachedGitIdentity;
        }
      }
      if (error.errorClass === "dubious_ownership") {
        recordDubiousOwnershipFallback(canonical);
      }
      return fallback;
    }
    throw error;
  }
}
function resolveProjectIdentityOrFallback(directory) {
  try {
    return resolveProjectIdentity(directory);
  } catch (error) {
    const canonical = path3.resolve(directory);
    const fallback = directoryFallback(canonical);
    const message = error instanceof Error ? error.message : String(error);
    log(`[magic-context] project identity resolution failed for ${canonical}; using directory fallback ${fallback}: ${message}`);
    return fallback;
  }
}
function hasGitDir(canonical) {
  if (hasGitDirInAncestorChain(canonical)) {
    return true;
  }
  try {
    const realCanonical = realpathSync.native(canonical);
    return realCanonical !== canonical && hasGitDirInAncestorChain(realCanonical);
  } catch {
    return false;
  }
}
function gitRootInAncestorChain(startDirectory) {
  let current = startDirectory;
  while (true) {
    if (existsSync(path3.join(current, ".git"))) {
      try {
        return realpathSync.native(current);
      } catch {
        return path3.resolve(current);
      }
    }
    const parent = path3.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
function hasGitDirInAncestorChain(startDirectory) {
  return gitRootInAncestorChain(startDirectory) !== null;
}
function gitRootDirectory(canonical) {
  const direct = gitRootInAncestorChain(canonical);
  if (direct)
    return direct;
  try {
    const realCanonical = realpathSync.native(canonical);
    return realCanonical === canonical ? null : gitRootInAncestorChain(realCanonical);
  } catch {
    return null;
  }
}
function resolveProjectIdentityForSession(directory, allowHomeProject = false) {
  const canonicalHome = canonicalUserHomeDirectory();
  const canonicalDirectory = (() => {
    try {
      return realpathSync.native(path3.resolve(directory));
    } catch {
      return path3.resolve(directory);
    }
  })();
  const inheritsHomeRepository = gitRootDirectory(canonicalDirectory) === canonicalHome;
  if (canonicalDirectory === canonicalHome || inheritsHomeRepository) {
    if (!allowHomeProject)
      return;
    return directoryFallback(canonicalHome);
  }
  return resolveProjectIdentityOrFallback(directory);
}
function normalizeStoredProjectPath(rawOrStored) {
  if (rawOrStored.startsWith("git:") || rawOrStored.startsWith("dir:")) {
    return rawOrStored;
  }
  try {
    return resolveProjectIdentity(rawOrStored);
  } catch {
    return directoryFallback(rawOrStored);
  }
}
function storedPathBelongsToIdentity(storedProjectPath, projectIdentity) {
  return storedProjectPath === projectIdentity || normalizeStoredProjectPath(storedProjectPath) === projectIdentity;
}

// ../plugin/src/shared/error-message.ts
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function readString(value) {
  if (typeof value === "string" && value.length > 0)
    return value;
  if (typeof value === "number")
    return String(value);
  return;
}
function clip(value, max) {
  if (value.length <= max)
    return value;
  return `${value.slice(0, max)}…`;
}
function describeError(error) {
  const stringForm = clip(safeString(error), 400);
  if (!(error instanceof Error) && !(error && typeof error === "object")) {
    return {
      name: typeof error,
      message: "",
      stringForm,
      brief: stringForm || "<empty>"
    };
  }
  const obj = error;
  const nameFromField = readString(obj.name);
  const nameFromCtor = error?.constructor?.name;
  const name = nameFromField ?? nameFromCtor ?? "Error";
  const message = readString(obj.message) ?? "";
  const status = readString(obj.status) ?? readString(obj.statusCode);
  const code = readString(obj.code);
  let causeName;
  const cause = obj.cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause;
    causeName = readString(causeRecord.name) ?? cause.constructor?.name;
  }
  const stack = readString(obj.stack);
  const stackHead = stack ? stack.split(`
`).slice(0, 4).map((l) => l.trim()).filter((l) => l.length > 0).join(" | ") : undefined;
  const briefParts = [];
  if (name)
    briefParts.push(name);
  if (message)
    briefParts.push(`message="${clip(message, 200)}"`);
  if (status)
    briefParts.push(`status=${status}`);
  if (code)
    briefParts.push(`code=${code}`);
  if (causeName)
    briefParts.push(`cause=${causeName}`);
  if (!message && stringForm && stringForm !== name) {
    briefParts.push(`str="${clip(stringForm, 200)}"`);
  }
  const brief = briefParts.join(" ") || stringForm || name;
  return {
    name,
    message,
    ...status ? { status } : {},
    ...code ? { code } : {},
    ...causeName ? { causeName } : {},
    ...stackHead ? { stackHead } : {},
    stringForm,
    brief
  };
}
function safeString(value) {
  try {
    return String(value);
  } catch {
    return "<unstringifiable>";
  }
}

// ../plugin/src/shared/rpc-utils.ts
var rpcIdentityProcessKill = process.kill;
var rpcIdentityPlatform = process.platform;

// ../plugin/src/shared/sqlite.ts
function detectSqliteRuntime() {
  const hasBunVersion = typeof process !== "undefined" && typeof process.versions?.bun === "string";
  const hasBunGlobal = typeof globalThis !== "undefined" && typeof globalThis.Bun !== "undefined";
  return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}
var bunSpec = "bun:" + "sqlite";
var nodeSpec = "node:" + "sqlite";
async function importSqliteModule(specifier) {
  return await import(specifier);
}
function isModuleNotFoundError(error, specifier) {
  const candidate = error;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const message = error instanceof Error ? error.message : String(error ?? "");
  const details = `${code} ${name} ${message}`.toLowerCase();
  const mentionsSpecifier = details.includes(specifier.toLowerCase());
  if (!mentionsSpecifier)
    return false;
  return code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_BUILTIN_MODULE" || code === "MODULE_NOT_FOUND" || name === "ResolveMessage" || details.includes("module not found") || details.includes("cannot find module") || details.includes("cannot find package") || details.includes("no such built-in module");
}

class SqliteRuntimeUnavailableError extends Error {
  runtime;
  specifier;
  constructor(runtime, specifier, cause) {
    const requirement = specifier === nodeSpec ? "Requires Node.js >= 24, or Bun with bun:sqlite — this Bun build lacks node:sqlite." : "Requires Bun with bun:sqlite, or Node.js >= 24 — this Bun build lacks bun:sqlite.";
    super(`Magic Context detected ${runtime}, but could not load ${specifier}. ${requirement}`, { cause });
    this.name = "SqliteRuntimeUnavailableError";
    this.runtime = runtime;
    this.specifier = specifier;
  }
}
async function loadSqliteModule(runtime = detectSqliteRuntime(), importer = importSqliteModule) {
  const specifier = runtime === "Bun" ? bunSpec : nodeSpec;
  try {
    return await importer(specifier);
  } catch (error) {
    if (isModuleNotFoundError(error, specifier)) {
      throw new SqliteRuntimeUnavailableError(runtime, specifier, error);
    }
    throw error;
  }
}
var detectedRuntime = detectSqliteRuntime();
var isBun = detectedRuntime === "Bun";
var sqliteModule = await loadSqliteModule(detectedRuntime);
var DatabaseImpl = isBun ? sqliteModule.Database : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);
function buildNodeSqliteDatabaseClass(DatabaseSync) {
  const SAVEPOINT = "mc_tx_sp";

  class NodeSqliteDatabase extends DatabaseSync {
    constructor(filename, options) {
      const translated = { ...options };
      if (options && "readonly" in options) {
        translated.readOnly = options.readonly;
        delete translated.readonly;
      }
      super(typeof filename === "string" ? filename : ":memory:", translated);
    }
    prepare(sql) {
      const stmt = super.prepare(sql);
      for (const method of ["run", "get", "all"]) {
        const original = stmt[method].bind(stmt);
        stmt[method] = (...args) => args.length === 1 && Array.isArray(args[0]) ? original(...args[0]) : original(...args);
      }
      return stmt;
    }
    transaction(fn) {
      const self = this;
      const execute = (mode, receiver, args) => {
        const nested = self.isTransaction === true;
        self.exec(nested ? `SAVEPOINT ${SAVEPOINT}` : `BEGIN${mode ? ` ${mode}` : ""}`);
        try {
          const result = fn.apply(receiver, args);
          self.exec(nested ? `RELEASE ${SAVEPOINT}` : "COMMIT");
          return result;
        } catch (error) {
          if (nested) {
            self.exec(`ROLLBACK TO ${SAVEPOINT}`);
            self.exec(`RELEASE ${SAVEPOINT}`);
          } else {
            self.exec("ROLLBACK");
          }
          throw error;
        }
      };
      const wrapped = function(...args) {
        return execute("", this, args);
      };
      wrapped.default = function(...args) {
        return execute("", this, args);
      };
      wrapped.deferred = function(...args) {
        return execute("DEFERRED", this, args);
      };
      wrapped.immediate = function(...args) {
        return execute("IMMEDIATE", this, args);
      };
      wrapped.exclusive = function(...args) {
        return execute("EXCLUSIVE", this, args);
      };
      return wrapped;
    }
  }
  return NodeSqliteDatabase;
}
var Database = DatabaseImpl;
var privilegeDepth = new WeakMap;

// ../plugin/src/shared/sqlite-helpers.ts
function closeQuietly(db) {
  if (!db)
    return;
  try {
    db.close();
  } catch {}
}

// ../plugin/src/shared/storage-permissions.ts
var enforcePrivateStoragePermissions = true;
function shouldEnforcePrivateStoragePermissions() {
  return enforcePrivateStoragePermissions;
}

// ../plugin/src/features/magic-context/context-authority.ts
var moduleNoteEvaluationBridges = new Map;
var MAX_AUTHORITY_SEED_FRAME_BYTES = 900 * 1024;
var mirrorFlights = new WeakMap;

// ../plugin/src/hooks/magic-context/compartment-parser.ts
var COMPARTMENT_REGEX = /<compartment\s+([^>]*?)\s*>(.*?)<\/compartment>/gs;
var ATTR_START_REGEX = /\bstart="(\d+)"/;
var ATTR_END_REGEX = /\bend="(\d+)"/;
var ATTR_TITLE_REGEX = /\btitle="([^"]*)"/;
var ATTR_EPISODE_REGEX = /\bepisode_type="([^"]*)"/;
var ATTR_IMPORTANCE_REGEX = /\bimportance="(\d+)"/;
function makeTierOpenRegex(n) {
  return new RegExp(`<p${n}\\s*(/?)>`);
}
var TIER_OPEN_REGEXES = [
  makeTierOpenRegex(1),
  makeTierOpenRegex(2),
  makeTierOpenRegex(3),
  makeTierOpenRegex(4)
];
var TIER_CLOSE_ANY_REGEX = /<\/p\d/;
var TIER_OPEN_ANY_REGEX = /<p\d/;
var CATEGORY_BLOCK_REGEX = /<(PROJECT_RULES|ARCHITECTURE|CONSTRAINTS|CONFIG_VALUES|NAMING)>(.*?)<\/\1>/gs;
var FACT_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
var UNPROCESSED_REGEX = /<unprocessed_from>(\d+)<\/unprocessed_from>/;
var USER_OBSERVATIONS_REGEX = /<user_observations>(.*?)<\/user_observations>/s;
var USER_OBS_ITEM_REGEX = /^\s*\*\s*(.+)$/gm;
var PRIMER_CANDIDATES_REGEX = /<primer_candidates>(.*?)<\/primer_candidates>/s;
var PRIMER_ELEMENT_REGEX = /<primer\s+at_compartment="(\d+)"\s*>(.*?)<\/primer>/gs;
var PRIMER_ITEM_REGEX = /^\s*(?:\*|-|\d+\.)\s*(.+)$/gm;
var FACTS_BLOCK_REGEX = /<facts>(.*?)<\/facts>/s;
var EVENTS_BLOCK_REGEX = /<events>(.*?)<\/events>/s;
var EVENT_ELEMENT_REGEX = /<([a-z_]+)\s+at_compartment="(\d+)"\s*>(.*?)<\/\1>/gs;
var EVENT_FIELD_REGEX = /<([a-z_]+)\s*>(.*?)<\/\1>/gs;
function extractTier(inner, index) {
  const openMatch = TIER_OPEN_REGEXES[index].exec(inner);
  if (!openMatch)
    return;
  if (openMatch[1] === "/")
    return "";
  const rest = inner.slice(openMatch.index + openMatch[0].length);
  const closeAt = rest.search(TIER_CLOSE_ANY_REGEX);
  let body = closeAt === -1 ? rest : rest.slice(0, closeAt);
  const openInside = body.search(TIER_OPEN_ANY_REGEX);
  if (openInside !== -1)
    body = body.slice(0, openInside);
  return unescapeXml(body.trim());
}
function extractTiersFromInner(inner) {
  return {
    p1: extractTier(inner, 0),
    p2: extractTier(inner, 1),
    p3: extractTier(inner, 2),
    p4: extractTier(inner, 3)
  };
}
function parseCompartmentOutput(text) {
  const compartments = [];
  const facts = [];
  for (const match of text.matchAll(COMPARTMENT_REGEX)) {
    const attrs = match[1];
    const inner = match[2];
    const startMatch = attrs.match(ATTR_START_REGEX);
    const endMatch = attrs.match(ATTR_END_REGEX);
    const titleMatch = attrs.match(ATTR_TITLE_REGEX);
    if (!startMatch || !endMatch || !titleMatch)
      continue;
    const startMessage = parseInt(startMatch[1], 10);
    const endMessage = parseInt(endMatch[1], 10);
    const title = unescapeXml(titleMatch[1]);
    if (Number.isNaN(startMessage) || Number.isNaN(endMessage) || !title)
      continue;
    const episodeMatch = attrs.match(ATTR_EPISODE_REGEX);
    const importanceMatch = attrs.match(ATTR_IMPORTANCE_REGEX);
    const episodeType = episodeMatch ? unescapeXml(episodeMatch[1]) : undefined;
    const importance = importanceMatch ? parseInt(importanceMatch[1], 10) : undefined;
    const p1 = extractTier(inner, 0);
    if (typeof p1 === "string" && p1.length > 0) {
      const p2 = extractTier(inner, 1);
      const p3 = extractTier(inner, 2);
      const p4 = extractTier(inner, 3);
      compartments.push({
        startMessage,
        endMessage,
        title,
        content: p1,
        p1,
        p2: typeof p2 === "string" ? p2 : p1,
        p3: typeof p3 === "string" ? p3 : typeof p2 === "string" ? p2 : p1,
        p4: typeof p4 === "string" ? p4 : "",
        importance,
        episodeType
      });
      continue;
    }
    const content = unescapeXml(inner.trim());
    if (content) {
      compartments.push({
        startMessage,
        endMessage,
        title,
        content,
        importance,
        episodeType
      });
    }
  }
  const factsBlockMatch = text.match(FACTS_BLOCK_REGEX);
  const factsScope = factsBlockMatch ? factsBlockMatch[1] : text.replace(EVENTS_BLOCK_REGEX, "").replace(/<compartment\s+[^>]*?\s*>.*?<\/compartment>/gs, "");
  for (const categoryMatch of factsScope.matchAll(CATEGORY_BLOCK_REGEX)) {
    const category = categoryMatch[1];
    const blockContent = categoryMatch[2];
    for (const itemMatch of blockContent.matchAll(FACT_ITEM_REGEX)) {
      const content = unescapeXml(itemMatch[1].trim());
      if (content) {
        facts.push({ category, content });
      }
    }
  }
  const unprocessedMatch = text.match(UNPROCESSED_REGEX);
  const unprocessedFrom = unprocessedMatch ? parseInt(unprocessedMatch[1], 10) : null;
  const userObservations = [];
  const userObsMatch = text.match(USER_OBSERVATIONS_REGEX);
  if (userObsMatch) {
    for (const itemMatch of userObsMatch[1].matchAll(USER_OBS_ITEM_REGEX)) {
      const obs = unescapeXml(itemMatch[1].trim());
      if (obs)
        userObservations.push(obs);
    }
  }
  const primerCandidates = [];
  const primerMatch = text.match(PRIMER_CANDIDATES_REGEX);
  if (primerMatch) {
    const block = primerMatch[1];
    let sawElement = false;
    for (const el of block.matchAll(PRIMER_ELEMENT_REGEX)) {
      sawElement = true;
      const question = unescapeXml(el[2].trim());
      if (question) {
        primerCandidates.push({
          question,
          originCompartmentIndex: Number.parseInt(el[1], 10)
        });
      }
    }
    if (!sawElement) {
      for (const itemMatch of block.matchAll(PRIMER_ITEM_REGEX)) {
        const question = unescapeXml(itemMatch[1].trim());
        if (question)
          primerCandidates.push({ question });
      }
    }
  }
  const events = parseEvents(text);
  compartments.sort((a, b) => a.startMessage - b.startMessage);
  return { compartments, facts, events, unprocessedFrom, userObservations, primerCandidates };
}
function parseEvents(text) {
  const blockMatch = text.match(EVENTS_BLOCK_REGEX);
  if (!blockMatch)
    return [];
  const block = blockMatch[1];
  const events = [];
  for (const elMatch of block.matchAll(EVENT_ELEMENT_REGEX)) {
    const kind = elMatch[1];
    const atRaw = parseInt(elMatch[2], 10);
    const atCompartment = Number.isNaN(atRaw) ? null : atRaw;
    const fields = {};
    for (const fieldMatch of elMatch[3].matchAll(EVENT_FIELD_REGEX)) {
      const name = fieldMatch[1];
      const value = unescapeXml(fieldMatch[2].trim());
      if (value)
        fields[name] = value;
    }
    events.push({ kind, atCompartment, fields });
  }
  return events;
}
function unescapeXml(s) {
  return s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

// ../plugin/src/features/magic-context/storage-schema-helpers.ts
function ensureColumn(db, table, column, definition) {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !/^[a-z][a-z0-9_]*$/.test(column) || !/^[A-Z0-9_"'(),[\]\s]+$/i.test(definition)) {
    throw new Error(`Unsafe schema identifier: ${table}.${column} ${definition}`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  if (rows.some((row) => row.name === column)) {
    return;
  }
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    const recheck = db.prepare(`PRAGMA table_info(${table})`).all();
    if (recheck.some((row) => row.name === column)) {
      return;
    }
    throw err;
  }
}
function healAllNullColumns(db) {
  const existingColumns = getSessionMetaColumns(db);
  const fallbacks = [
    ["cache_ttl", ""],
    ["last_nudge_band", ""],
    ["last_nudge_level", ""],
    ["channel2_nudge_claim_token", ""],
    ["last_transform_error", ""],
    ["nudge_anchor_message_id", ""],
    ["nudge_anchor_text", ""],
    ["sticky_turn_reminder_text", ""],
    ["sticky_turn_reminder_message_id", ""],
    ["note_nudge_trigger_message_id", ""],
    ["note_nudge_sticky_text", ""],
    ["note_nudge_sticky_message_id", ""],
    ["last_todo_state", ""],
    ["todo_synthetic_call_id", ""],
    ["todo_synthetic_anchor_message_id", ""],
    ["todo_synthetic_state_json", ""],
    ["system_prompt_hash", ""],
    ["stripped_placeholder_ids", ""],
    ["stale_reduce_stripped_ids", ""],
    ["processed_image_stripped_ids", ""],
    ["memory_block_cache", ""],
    ["memory_block_ids", ""],
    ["compaction_marker_state", ""],
    ["key_files", ""],
    ["times_execute_threshold_reached", 0],
    ["compartment_in_progress", 0],
    ["historian_failure_count", 0],
    ["cleared_reasoning_through_tag", 0],
    ["memory_block_count", 0],
    ["system_prompt_tokens", 0],
    ["conversation_tokens", 0],
    ["tool_call_tokens", 0],
    ["note_nudge_trigger_pending", 0],
    ["observed_safe_input_tokens", 0],
    ["cache_alert_sent", 0],
    ["new_work_tokens", 0],
    ["total_input_tokens", 0],
    ["last_emergency_input_sample", 0],
    ["channel2_nudge_claimed_at", 0],
    ["last_usage_context_limit", 0],
    ["prior_boundary_ordinal", 1],
    ["protected_tail_policy_version", 0],
    ["protected_tail_drain_window_started_at", 0],
    ["protected_tail_drain_tokens", 0],
    ["recovery_no_eligible_head_count", 0],
    ["force_emergency_bypass_window_start", 0],
    ["force_emergency_bypass_used", 0],
    ["emergency_drain_active", 0],
    ["historian_drain_failure_at", 0]
  ];
  const presentFallbacks = fallbacks.filter(([column]) => existingColumns.has(column));
  if (presentFallbacks.length > 0) {
    const assignments = presentFallbacks.map(([column]) => `${column} = COALESCE(${column}, ?)`).join(", ");
    const nullPredicate = presentFallbacks.map(([column]) => `${column} IS NULL`).join(" OR ");
    db.prepare(`UPDATE session_meta SET ${assignments} WHERE ${nullPredicate}`).run(...presentFallbacks.map(([, fallback]) => fallback));
  }
  healMissingMemoryBlockIds(db, existingColumns);
}
function getSessionMetaColumns(db) {
  const rows = db.prepare("PRAGMA table_info(session_meta)").all();
  return new Set(rows.flatMap((row) => typeof row.name === "string" ? [row.name] : []));
}
function healMissingMemoryBlockIds(db, columns) {
  if (!columns.has("memory_block_cache") || !columns.has("memory_block_ids") || !columns.has("memory_block_count")) {
    return;
  }
  db.prepare("UPDATE session_meta SET memory_block_cache = '' WHERE memory_block_cache != '' AND (memory_block_ids IS NULL OR memory_block_ids = '') AND memory_block_count > 0").run();
}

// ../plugin/src/features/magic-context/workspaces.ts
import { createHash as createHash2 } from "node:crypto";
var VALID_SHARE_CATEGORIES = new Set(V2_MEMORY_CATEGORIES);
var DEFAULT_WORKSPACE_SHARE_CATEGORIES = ["CONSTRAINTS"];
function tableExists(db, tableName) {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(tableName);
  return Boolean(row);
}
function columnExists(db, tableName, columnName) {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return rows.some((row) => row.name === columnName);
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function placeholders(values) {
  return values.map(() => "?").join(", ");
}
function defaultWorkspaceShareCategories() {
  return [...DEFAULT_WORKSPACE_SHARE_CATEGORIES];
}
function warnInvalidShareCategories(reason, raw) {
  log("[magic-context] WARN: invalid workspace share_categories; sharing no foreign memory categories", {
    reason,
    raw
  });
}
function normalizeShareCategories(raw) {
  if (raw === null || raw === undefined) {
    return defaultWorkspaceShareCategories();
  }
  if (typeof raw !== "string") {
    warnInvalidShareCategories("not a string", raw);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnInvalidShareCategories("malformed JSON", raw);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warnInvalidShareCategories("not a JSON array", raw);
    return [];
  }
  const categories = [];
  for (const value of parsed) {
    if (typeof value !== "string" || !VALID_SHARE_CATEGORIES.has(value)) {
      warnInvalidShareCategories("unknown category", raw);
      return [];
    }
    if (!categories.includes(value))
      categories.push(value);
  }
  return categories.sort((left, right) => left.localeCompare(right));
}
function selectWorkspaceShareCategories(db, identities) {
  const candidates = uniqueSorted(identities.filter((identity) => identity.length > 0));
  if (candidates.length === 0 || !tableExists(db, "workspace_members")) {
    return null;
  }
  const hasMembership = Boolean(db.prepare(`SELECT 1
                   FROM workspace_members
                  WHERE project_path IN (${placeholders(candidates)})
                  LIMIT 1`).get(...candidates));
  if (!hasMembership)
    return null;
  if (!tableExists(db, "workspaces")) {
    log("[magic-context] WARN: workspace member has no workspaces table; sharing no foreign memory categories");
    return [];
  }
  if (!columnExists(db, "workspaces", "share_categories")) {
    return defaultWorkspaceShareCategories();
  }
  const row = db.prepare(`SELECT workspace.share_categories AS shareCategories
               FROM workspace_members AS member
               JOIN workspaces AS workspace ON workspace.id = member.workspace_id
              WHERE member.project_path IN (${placeholders(candidates)})
              ORDER BY workspace.id ASC
              LIMIT 1`).get(...candidates);
  if (!row) {
    log("[magic-context] WARN: workspace member has no workspace share_categories row; sharing no foreign memory categories");
    return [];
  }
  return normalizeShareCategories(row.shareCategories);
}
function resolveWorkspaceShareCategories(db, projectIdentity) {
  return selectWorkspaceShareCategories(db, [projectIdentity]);
}
function resolveWorkspaceIdentitySet(db, projectIdentity) {
  if (!tableExists(db, "workspace_members")) {
    return { identities: [projectIdentity], namesByIdentity: new Map };
  }
  const rows = db.prepare(`SELECT member.project_path AS identity, member.display_name AS displayName
               FROM workspace_members AS anchor
               JOIN workspace_members AS member ON member.workspace_id = anchor.workspace_id
              WHERE anchor.project_path = ?
              ORDER BY member.display_name ASC, member.project_path ASC`).all(projectIdentity);
  if (rows.length === 0) {
    return { identities: [projectIdentity], namesByIdentity: new Map };
  }
  const namesByIdentity = new Map;
  const identities = [];
  for (const row of rows) {
    if (typeof row.identity !== "string" || row.identity.length === 0)
      continue;
    if (identities.includes(row.identity))
      continue;
    identities.push(row.identity);
    if (typeof row.displayName === "string" && row.displayName.length > 0) {
      namesByIdentity.set(row.identity, row.displayName);
    }
  }
  return identities.length > 0 ? { identities, namesByIdentity } : { identities: [projectIdentity], namesByIdentity: new Map };
}
function expandWorkspaceIdentitySetWithAliases(db, identities) {
  const canonical = uniqueSorted(identities.filter((identity) => identity.length > 0));
  const expanded = new Set(canonical);
  const canonicalIdentityByStoredPath = new Map;
  for (const identity of canonical) {
    canonicalIdentityByStoredPath.set(identity, identity);
  }
  if (canonical.length === 0 || !tableExists(db, "v22_identity_rekey_map")) {
    return { expandedIdentities: [...expanded], canonicalIdentityByStoredPath };
  }
  const rows = db.prepare(`SELECT old_project_path AS oldProjectPath, new_project_path AS newProjectPath
               FROM v22_identity_rekey_map
              WHERE new_project_path IN (${placeholders(canonical)})
              ORDER BY old_project_path ASC`).all(...canonical);
  for (const row of rows) {
    if (typeof row.oldProjectPath !== "string" || typeof row.newProjectPath !== "string") {
      continue;
    }
    if (!canonicalIdentityByStoredPath.has(row.newProjectPath))
      continue;
    expanded.add(row.oldProjectPath);
    canonicalIdentityByStoredPath.set(row.oldProjectPath, row.newProjectPath);
  }
  return { expandedIdentities: [...expanded], canonicalIdentityByStoredPath };
}
function resolveStoredPathWorkspaceIdentity(storedProjectPath, memberIdentities, canonicalIdentityByStoredPath) {
  const direct = canonicalIdentityByStoredPath.get(storedProjectPath);
  if (direct)
    return direct;
  const normalized = normalizeStoredProjectPath(storedProjectPath);
  const normalizedDirect = canonicalIdentityByStoredPath.get(normalized);
  if (normalizedDirect)
    return normalizedDirect;
  if (memberIdentities.includes(normalized))
    return normalized;
  for (const identity of memberIdentities) {
    if (storedPathBelongsToIdentity(storedProjectPath, identity)) {
      return identity;
    }
  }
  return null;
}
function sourceNameForMemory(storedProjectPath, ownIdentity, memberIdentities, namesByIdentity, canonicalIdentityByStoredPath) {
  const canonicalIdentity = resolveStoredPathWorkspaceIdentity(storedProjectPath, memberIdentities, canonicalIdentityByStoredPath);
  if (!canonicalIdentity || canonicalIdentity === ownIdentity)
    return;
  return namesByIdentity.get(canonicalIdentity);
}
function getEpochMap(db, identities) {
  if (identities.length === 0)
    return new Map;
  const rows = db.prepare(`SELECT project_path AS projectPath, project_memory_epoch AS epoch
               FROM project_state
              WHERE project_path IN (${placeholders(identities)})`).all(...identities);
  const epochs = new Map;
  for (const row of rows) {
    if (typeof row.projectPath !== "string" || typeof row.epoch !== "number")
      continue;
    epochs.set(row.projectPath, row.epoch);
  }
  return epochs;
}
function computeWorkspaceEpochFingerprint(db, identities) {
  const canonical = uniqueSorted(identities.filter((identity) => identity.length > 0));
  const epochs = getEpochMap(db, canonical);
  const shareCategories = selectWorkspaceShareCategories(db, canonical);
  const hash = createHash2("sha256");
  hash.update("share_categories", "utf8");
  hash.update("\x00");
  hash.update(shareCategories === null ? "NO_WORKSPACE" : JSON.stringify(shareCategories), "utf8");
  hash.update(`
`);
  for (const identity of canonical) {
    hash.update(identity, "utf8");
    hash.update("\x00");
    hash.update(String(epochs.get(identity) ?? 0), "utf8");
    hash.update(`
`);
  }
  return hash.digest("hex");
}
function isInTransaction(db) {
  const candidate = db;
  return candidate.inTransaction === true || candidate.isTransaction === true;
}
function bumpEpochRows(db, identities, now) {
  const stmt = db.prepare(`INSERT INTO project_state
            (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(project_path) DO UPDATE SET
            project_memory_epoch = project_memory_epoch + 1,
            updated_at = excluded.updated_at`);
  for (const identity of uniqueSorted(identities)) {
    stmt.run(identity, now);
  }
}
function bumpEpochsForWorkspaceMemberSet(db, identities, now = Date.now()) {
  const run = () => bumpEpochRows(db, identities, now);
  if (isInTransaction(db)) {
    run();
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    run();
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  }
}

// ../plugin/src/features/magic-context/migrations.ts
var FORK_MIGRATION_VERSION_FLOOR = 1e4;
function tableExists2(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
}
function healMismatchedTierClose(db, table, hasLegacy) {
  if (!tableExists2(db, table))
    return;
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
  for (const required of ["content", "p1", "p2", "p3", "p4"]) {
    if (!columns.has(required))
      return;
  }
  if (hasLegacy && !columns.has("legacy"))
    return;
  const predicate = hasLegacy ? "legacy = 1 AND p1 IS NULL AND content LIKE '%<p1%'" : "p1 IS NULL AND content LIKE '%<p1%'";
  const rows = db.prepare(`SELECT id, content FROM ${table} WHERE ${predicate}`).all();
  const update = db.prepare(`UPDATE ${table} SET p1 = ?, p2 = ?, p3 = ?, p4 = ?${hasLegacy ? ", legacy = 0" : ""} WHERE id = ?`);
  for (const row of rows) {
    const tiers = extractTiersFromInner(row.content);
    if (typeof tiers.p1 !== "string" || tiers.p1.length === 0)
      continue;
    const p1 = tiers.p1;
    const p2 = typeof tiers.p2 === "string" ? tiers.p2 : p1;
    const p3 = typeof tiers.p3 === "string" ? tiers.p3 : p2;
    const p4 = typeof tiers.p4 === "string" ? tiers.p4 : "";
    update.run(p1, p2, p3, p4, row.id);
  }
}
function assertForeignKeyIntegrity(db, table) {
  const rows = (table ? db.prepare(`PRAGMA foreign_key_check(${table})`) : db.prepare("PRAGMA foreign_key_check")).all();
  if (rows.length > 0) {
    throw new Error(`foreign_key_check failed after embedding table rebuild${table ? ` (${table})` : ""} (${rows.length} violation(s))`);
  }
}
function authorityPrivilegeCheck() {
  return "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
}
function managedAuthorityNoteRow(row) {
  return `(
        EXISTS (SELECT 1 FROM authority_managed WHERE project_path = ${row}.project_path)
        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = ${row}.project_path)
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_managed am ON am.project_path = sp.project_path
            WHERE sp.session_id = ${row}.session_id
        )
        OR EXISTS (
            SELECT 1 FROM session_projects sp
            JOIN authority_repair_pending arp ON arp.project_path = sp.project_path
            WHERE sp.session_id = ${row}.session_id
        )
    )`;
}
function installLatestAuthorityTriggers(db) {
  const privilegeCheck = authorityPrivilegeCheck();
  if (tableExists2(db, "memories")) {
    db.exec(`
            DROP TRIGGER IF EXISTS memories_authority_guard_insert;
            DROP TRIGGER IF EXISTS memories_authority_guard_update;
            DROP TRIGGER IF EXISTS memories_authority_guard_delete;
            CREATE TRIGGER memories_authority_guard_insert
            BEFORE INSERT ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            CREATE TRIGGER memories_authority_guard_update
            BEFORE UPDATE ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
            CREATE TRIGGER memories_authority_guard_delete
            BEFORE DELETE ON memories
            WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
               OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
              AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
        `);
  }
  if (tableExists2(db, "notes")) {
    const managedOld = managedAuthorityNoteRow("OLD");
    const managedNew = managedAuthorityNoteRow("NEW");
    db.exec(`
            DROP TRIGGER IF EXISTS notes_authority_guard_insert;
            DROP TRIGGER IF EXISTS notes_authority_guard_update;
            DROP TRIGGER IF EXISTS notes_authority_guard_delete;
            CREATE TRIGGER notes_authority_guard_insert
            BEFORE INSERT ON notes
            WHEN ${managedNew} AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
            CREATE TRIGGER notes_authority_guard_update
            BEFORE UPDATE ON notes
            WHEN (${managedOld} OR ${managedNew}) AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
            CREATE TRIGGER notes_authority_guard_delete
            BEFORE DELETE ON notes
            WHEN ${managedOld} AND ${privilegeCheck}
            BEGIN SELECT RAISE(ABORT, 'context.db note writes are managed by the Rust module'); END;
        `);
  }
}
var MIGRATIONS = [
  {
    version: 1,
    description: "Merge session_notes + smart_notes into unified notes table",
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS notes (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL DEFAULT 'session',
					status TEXT NOT NULL DEFAULT 'active',
					content TEXT NOT NULL,
					session_id TEXT,
					project_path TEXT,
					surface_condition TEXT,
					created_at INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					last_checked_at INTEGER,
					ready_at INTEGER,
					ready_reason TEXT,
					compiled_provider TEXT,
					compiled_config TEXT,
					compiled_at INTEGER,
					compile_status TEXT CHECK(compile_status IN ('compiled', 'plain', 'refused'))
				);
				CREATE INDEX IF NOT EXISTS idx_notes_session_status ON notes(session_id, status);
				CREATE INDEX IF NOT EXISTS idx_notes_project_status ON notes(project_path, status);
				CREATE INDEX IF NOT EXISTS idx_notes_type_status ON notes(type, status);
			`);
      const hasSessionNotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='session_notes'").get();
      if (hasSessionNotes) {
        db.exec(`
					INSERT INTO notes (type, status, content, session_id, created_at, updated_at)
					SELECT 'session', 'active', content, session_id, created_at, created_at
					FROM session_notes
				`);
      }
      const hasSmartNotes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='smart_notes'").get();
      if (hasSmartNotes) {
        db.exec(`
					INSERT INTO notes (type, status, content, session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason)
					SELECT 'smart', status, content, created_session_id, project_path, surface_condition,
						created_at, updated_at, last_checked_at, ready_at, ready_reason
					FROM smart_notes
				`);
      }
      if (hasSessionNotes) {
        const sourceCount = db.prepare("SELECT COUNT(*) as c FROM session_notes").get().c;
        const migratedCount = db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'session'").get().c;
        if (migratedCount >= sourceCount) {
          db.exec("DROP TABLE session_notes");
        } else {
          throw new Error(`session_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`);
        }
      }
      if (hasSmartNotes) {
        const sourceCount = db.prepare("SELECT COUNT(*) as c FROM smart_notes").get().c;
        const migratedCount = db.prepare("SELECT COUNT(*) as c FROM notes WHERE type = 'smart'").get().c;
        if (migratedCount >= sourceCount) {
          db.exec("DROP TABLE smart_notes");
        } else {
          throw new Error(`smart_notes migration verification failed: expected ${sourceCount} rows, got ${migratedCount}`);
        }
      }
    }
  },
  {
    version: 2,
    description: "Add plugin_messages table for TUI ↔ server communication",
    up: (db) => {
      db.exec(`
				CREATE TABLE IF NOT EXISTS plugin_messages (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					direction TEXT NOT NULL,
					type TEXT NOT NULL,
					payload TEXT NOT NULL DEFAULT '{}',
					session_id TEXT,
					created_at INTEGER NOT NULL,
					consumed_at INTEGER
				);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_direction_consumed
					ON plugin_messages(direction, consumed_at);
				CREATE INDEX IF NOT EXISTS idx_plugin_messages_created
					ON plugin_messages(created_at);
			`);
    }
  },
  {
    version: 3,
    description: "Add user_memory_candidates and user_memories tables",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS user_memory_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_umc_created ON user_memory_candidates(created_at);

                CREATE TABLE IF NOT EXISTS user_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    content TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'active',
                    promoted_at INTEGER NOT NULL,
                    source_candidate_ids TEXT DEFAULT '[]',
                    source_candidate_provenance TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_um_status ON user_memories(status);
            `);
    }
  },
  {
    version: 4,
    description: "Add git_commits + git_commit_embeddings + git_commits_fts tables",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS git_commits (
                    sha TEXT PRIMARY KEY,
                    project_path TEXT NOT NULL,
                    short_sha TEXT NOT NULL,
                    message TEXT NOT NULL,
                    author TEXT,
                    committed_at INTEGER NOT NULL,
                    indexed_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_git_commits_project_time
                    ON git_commits(project_path, committed_at DESC);

                CREATE TABLE IF NOT EXISTS git_commit_embeddings (
                    sha TEXT PRIMARY KEY,
                    embedding BLOB NOT NULL,
                    model_id TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    -- FK-cascade audit (v12): git_commit_embeddings.sha -> git_commits.sha
                    -- uses ON DELETE CASCADE, so SQLite PRAGMA foreign_keys must be ON on
                    -- every connection and v12 cleans historical orphan rows.
                    FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
                    sha UNINDEXED,
                    project_path UNINDEXED,
                    message,
                    tokenize = 'porter unicode61'
                );

                -- Mirror writes into FTS. We intentionally rebuild FTS rows on
                -- every INSERT OR REPLACE so amended commits or re-indexed
                -- messages update cleanly.
                CREATE TRIGGER IF NOT EXISTS git_commits_fts_insert
                AFTER INSERT ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = NEW.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_delete
                AFTER DELETE ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                END;

                CREATE TRIGGER IF NOT EXISTS git_commits_fts_update
                AFTER UPDATE OF message, project_path ON git_commits BEGIN
                    DELETE FROM git_commits_fts WHERE sha = OLD.sha;
                    INSERT INTO git_commits_fts(sha, project_path, message)
                    VALUES (NEW.sha, NEW.project_path, NEW.message);
                END;
            `);
    }
  },
  {
    version: 5,
    description: "One-shot heal of NULL session_meta columns",
    up: (db) => {
      healAllNullColumns(db);
    }
  },
  {
    version: 6,
    description: "Heal session_meta.counter drift below MAX(tag_number)",
    up: (db) => {
      db.prepare(`UPDATE session_meta
                 SET counter = (
                     SELECT MAX(tag_number)
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                 )
                 WHERE EXISTS (
                     SELECT 1
                     FROM tags
                     WHERE tags.session_id = session_meta.session_id
                       AND tags.tag_number > session_meta.counter
                 )`).run();
    }
  },
  {
    version: 7,
    description: "Add harness column to notes table for cross-harness sharing",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(notes)").all();
      if (!cols.some((c) => c.name === "harness")) {
        db.exec("ALTER TABLE notes ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'");
      }
    }
  },
  {
    version: 8,
    description: "Add partial indexes on tags(session_id, tag_number) for active and dropped",
    up: (db) => {
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_active_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'active';

                CREATE INDEX IF NOT EXISTS idx_tags_dropped_session_tag_number
                ON tags(session_id, tag_number)
                WHERE status = 'dropped';
            `);
      db.exec("ANALYZE tags;");
    }
  },
  {
    version: 9,
    description: "Persist tool_definition_measurements across plugin restarts",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS tool_definition_measurements (
                    provider_id TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    agent_name TEXT NOT NULL,
                    tool_id TEXT NOT NULL,
                    token_count INTEGER NOT NULL,
                    recorded_at INTEGER NOT NULL,
                    PRIMARY KEY (provider_id, model_id, agent_name, tool_id)
                );
            `);
    }
  },
  {
    version: 10,
    description: "Add tool_owner_message_id column to tags + composite identity indexes",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(tags)").all();
      if (!cols.some((c) => c.name === "tool_owner_message_id")) {
        db.exec("ALTER TABLE tags ADD COLUMN tool_owner_message_id TEXT DEFAULT NULL");
      }
      db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tool_composite
                ON tags(session_id, message_id, tool_owner_message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NOT NULL;

                CREATE INDEX IF NOT EXISTS idx_tags_tool_null_owner
                ON tags(session_id, message_id)
                WHERE type = 'tool' AND tool_owner_message_id IS NULL;
            `);
    }
  },
  {
    version: 11,
    description: "Add todo state synthesis columns to session_meta",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "last_todo_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN last_todo_state TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "todo_synthetic_call_id")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN todo_synthetic_call_id TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "todo_synthetic_anchor_message_id")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN todo_synthetic_anchor_message_id TEXT DEFAULT ''");
      }
      if (!cols.some((c) => c.name === "todo_synthetic_state_json")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN todo_synthetic_state_json TEXT DEFAULT ''");
      }
    }
  },
  {
    version: 12,
    description: "Clean orphan rows from FK-cascade embedding tables",
    up: (db) => {
      const hasTable = (name) => Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name));
      const memoryEmbeddings = hasTable("memory_embeddings") ? db.prepare(`DELETE FROM memory_embeddings
                           WHERE memory_id NOT IN (SELECT id FROM memories)`).run().changes : 0;
      log(`[migrations] v12 cleaned ${memoryEmbeddings} orphan memory_embeddings row(s)`);
      const gitCommitEmbeddings = hasTable("git_commit_embeddings") ? db.prepare(`DELETE FROM git_commit_embeddings
                           WHERE sha NOT IN (SELECT sha FROM git_commits)`).run().changes : 0;
      log(`[migrations] v12 cleaned ${gitCommitEmbeddings} orphan git_commit_embeddings row(s)`);
    }
  },
  {
    version: 13,
    description: "Add pending_compaction_marker_state column for deferred marker drain",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "pending_compaction_marker_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN pending_compaction_marker_state TEXT");
      }
    }
  },
  {
    version: 14,
    description: "Add project-scoped key files and version counter",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS project_key_files (
                    project_path           TEXT    NOT NULL,
                    path                   TEXT    NOT NULL,
                    content                TEXT    NOT NULL,
                    content_hash           TEXT    NOT NULL,
                    local_token_estimate   INTEGER NOT NULL,
                    generated_at           INTEGER NOT NULL,
                    generated_by_model     TEXT,
                    generation_config_hash TEXT    NOT NULL,
                    stale_reason           TEXT,
                    PRIMARY KEY (project_path, path)
                );

                CREATE INDEX IF NOT EXISTS idx_project_key_files_project
                    ON project_key_files(project_path);
                CREATE INDEX IF NOT EXISTS idx_project_key_files_generated_at
                    ON project_key_files(project_path, generated_at);

                CREATE TABLE IF NOT EXISTS project_key_files_version (
                    project_path TEXT    PRIMARY KEY,
                    version      INTEGER NOT NULL DEFAULT 0
                );
            `);
    }
  },
  {
    version: 15,
    description: "Add deferred_execute_state column for boundary execution drain",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "deferred_execute_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN deferred_execute_state TEXT");
      }
    }
  },
  {
    version: 16,
    description: "Add context-limit cache regression sentinels",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "observed_safe_input_tokens")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.some((c) => c.name === "cache_alert_sent")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN cache_alert_sent INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  {
    version: 17,
    description: "Multi-anchor JSON storage for note-nudge and auto-search-hint persistence",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "note_nudge_anchors")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN note_nudge_anchors TEXT NOT NULL DEFAULT '[]'");
      }
      if (!cols.some((c) => c.name === "auto_search_hint_decisions")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN auto_search_hint_decisions TEXT NOT NULL DEFAULT '[]'");
      }
      db.exec(`
                UPDATE session_meta
                SET note_nudge_anchors = json_array(
                    json_object(
                        'messageId', note_nudge_sticky_message_id,
                        'text', note_nudge_sticky_text
                    )
                )
                WHERE COALESCE(note_nudge_sticky_text, '') != ''
                  AND COALESCE(note_nudge_sticky_message_id, '') != ''
                  AND (note_nudge_anchors IS NULL OR note_nudge_anchors = '[]')
            `);
      db.exec(`
                UPDATE session_meta SET note_nudge_anchors = '[]'
                WHERE note_nudge_anchors IS NULL
            `);
      db.exec(`
                UPDATE session_meta SET auto_search_hint_decisions = '[]'
                WHERE auto_search_hint_decisions IS NULL
            `);
    }
  },
  {
    version: 18,
    description: "Add pending_pi_compaction_marker_state column for Pi deferred marker drain",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "pending_pi_compaction_marker_state")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN pending_pi_compaction_marker_state TEXT");
      }
    }
  },
  {
    version: 19,
    description: "Add compartment state lease table",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_state_lease (
                    session_id TEXT PRIMARY KEY NOT NULL,
                    holder_id TEXT NOT NULL,
                    acquired_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_state_lease_expires
                    ON compartment_state_lease(expires_at);
            `);
    }
  },
  {
    version: 20,
    description: "Add subagent invocation token accounting",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS subagent_invocations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL,
                    subagent TEXT NOT NULL,
                    task TEXT,
                    provider_id TEXT,
                    model_id TEXT,
                    started_at INTEGER NOT NULL,
                    ended_at INTEGER,
                    status TEXT NOT NULL,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
                    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                    error TEXT,
                    parent_invocation_id INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_sai_session_started
                    ON subagent_invocations(session_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_sai_subagent
                    ON subagent_invocations(subagent, started_at DESC);
            `);
    }
  },
  {
    version: 21,
    description: "Add session lifetime work metrics",
    up: (db) => {
      const cols = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!cols.some((c) => c.name === "new_work_tokens")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN new_work_tokens INTEGER NOT NULL DEFAULT 0");
      }
      if (!cols.some((c) => c.name === "total_input_tokens")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  {
    version: 22,
    description: "v2.0 cache architecture schema foundation",
    up: (db) => {
      const hasSessionMetaTable = tableExists2(db, "session_meta");
      const hasCompartmentsTable = tableExists2(db, "compartments");
      const hasMemoriesTable = tableExists2(db, "memories");
      if (hasSessionMetaTable) {
        ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
        ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
        ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
        ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
        ensureColumn(db, "session_meta", "upgrade_reminded_at", "INTEGER");
      }
      if (hasCompartmentsTable) {
        ensureColumn(db, "compartments", "p1", "TEXT");
        ensureColumn(db, "compartments", "p2", "TEXT");
        ensureColumn(db, "compartments", "p3", "TEXT");
        ensureColumn(db, "compartments", "p4", "TEXT");
        ensureColumn(db, "compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
        ensureColumn(db, "compartments", "episode_type", "TEXT");
        ensureColumn(db, "compartments", "p1_embedding", "BLOB");
        ensureColumn(db, "compartments", "p1_embedding_model_id", "TEXT");
        ensureColumn(db, "compartments", "legacy", "INTEGER NOT NULL DEFAULT 0");
      }
      const hasRecompCompartmentsTable = tableExists2(db, "recomp_compartments");
      if (hasRecompCompartmentsTable) {
        ensureColumn(db, "recomp_compartments", "p1", "TEXT");
        ensureColumn(db, "recomp_compartments", "p2", "TEXT");
        ensureColumn(db, "recomp_compartments", "p3", "TEXT");
        ensureColumn(db, "recomp_compartments", "p4", "TEXT");
        ensureColumn(db, "recomp_compartments", "importance", "INTEGER NOT NULL DEFAULT 50");
        ensureColumn(db, "recomp_compartments", "episode_type", "TEXT");
      }
      if (hasMemoriesTable) {
        ensureColumn(db, "memories", "importance", "INTEGER");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS schema_migrations_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS project_state (
                    project_path TEXT PRIMARY KEY,
                    project_memory_epoch INTEGER NOT NULL DEFAULT 0,
                    project_user_profile_version INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS m0_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'compartment_delete',
                        'compartment_merge',
                        'recomp_boundary_change',
                        'compartment_upgrade'
                    )),
                    target_id INTEGER,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_m0_mutation_log_session
                    ON m0_mutation_log(session_id);

                CREATE TABLE IF NOT EXISTS v22_identity_rekey_map (
                    old_project_path TEXT PRIMARY KEY,
                    new_project_path TEXT NOT NULL,
                    rekeyed_at INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS v22_backfill_failures (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    table_name TEXT NOT NULL,
                    row_id INTEGER NOT NULL,
                    raw_project_path TEXT NOT NULL,
                    error_class TEXT NOT NULL CHECK (error_class IN (
                        'not_git_repo',
                        'git_missing',
                        'git_timeout',
                        'permission_denied',
                        'unknown'
                    )),
                    error_message TEXT,
                    failed_at INTEGER NOT NULL,
                    UNIQUE(table_name, row_id)
                );
            `);
      if (hasCompartmentsTable) {
        db.exec(`
                    INSERT OR IGNORE INTO schema_migrations_meta (key, value)
                    SELECT 'v22_legacy_compartment_boundary', CAST(COALESCE(MAX(id), 0) AS TEXT)
                    FROM compartments
                `);
        const boundaryRow = db.prepare("SELECT value FROM schema_migrations_meta WHERE key = 'v22_legacy_compartment_boundary'").get();
        const compartmentBoundary = Number.parseInt(boundaryRow?.value ?? "0", 10);
        db.prepare("UPDATE compartments SET legacy = 1 WHERE legacy = 0 AND id <= ?").run(Number.isFinite(compartmentBoundary) ? compartmentBoundary : 0);
      } else {
        db.prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_compartment_boundary', '0')").run();
      }
      db.prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES ('v22_legacy_memory_backfill', 'pending')").run();
    }
  },
  {
    version: 23,
    description: "v2 compartment events storage (causal_incident / trajectory_correction)",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    compartment_id INTEGER,
                    kind TEXT NOT NULL,
                    at_compartment INTEGER,
                    fields_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode'
                );
                CREATE INDEX IF NOT EXISTS idx_compartment_events_session
                    ON compartment_events(session_id);
            `);
    }
  },
  {
    version: 24,
    description: "historian_runs metrics (per-run quality/cost telemetry)",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS historian_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    subagent_invocation_id INTEGER,
                    run_kind TEXT NOT NULL,
                    status TEXT NOT NULL,
                    failure_reason TEXT,
                    chunk_start_ordinal INTEGER,
                    chunk_end_ordinal INTEGER,
                    unprocessed_from INTEGER,
                    compartments_produced INTEGER NOT NULL DEFAULT 0,
                    compartment_id_min INTEGER,
                    compartment_id_max INTEGER,
                    facts_emitted INTEGER NOT NULL DEFAULT 0,
                    facts_by_category_json TEXT,
                    events_emitted INTEGER NOT NULL DEFAULT 0,
                    importance_min INTEGER,
                    importance_max INTEGER,
                    importance_avg REAL,
                    discarded_last INTEGER NOT NULL DEFAULT 0,
                    legacy INTEGER NOT NULL DEFAULT 0,
                    created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_historian_runs_session
                    ON historian_runs(session_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS idx_historian_runs_status
                    ON historian_runs(status, created_at DESC);
            `);
    }
  },
  {
    version: 25,
    description: "pi_stable_id_scheme session_meta column (Pi message-id cutover gate)",
    up: (db) => {
      const rows = db.prepare("PRAGMA table_info(session_meta)").all();
      if (!rows.some((row) => row.name === "pi_stable_id_scheme")) {
        db.exec("ALTER TABLE session_meta ADD COLUMN pi_stable_id_scheme INTEGER");
      }
    }
  },
  {
    version: 26,
    description: "memory mutation log and atomic m[1] cache columns",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS memory_mutation_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    mutation_type TEXT NOT NULL CHECK (mutation_type IN (
                        'archive',
                        'delete',
                        'update',
                        'superseded'
                    )),
                    target_memory_id INTEGER NOT NULL,
                    superseded_by_id INTEGER,
                    category TEXT,
                    new_content TEXT,
                    queued_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_project
                    ON memory_mutation_log(project_path, id);
            `);
      ensureColumn(db, "session_meta", "cached_m0_bytes", "BLOB");
      ensureColumn(db, "session_meta", "cached_m0_project_memory_epoch", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_project_user_profile_version", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_compartment_seq", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_memory_id", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_mutation_id", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_max_memory_mutation_id", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_project_docs_hash", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_materialized_at", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_session_facts_version", "INTEGER");
      ensureColumn(db, "session_meta", "cached_m0_upgrade_state", "TEXT");
      ensureColumn(db, "session_meta", "cached_m1_bytes", "BLOB");
      ensureColumn(db, "session_meta", "last_observed_model_key", "TEXT");
      ensureColumn(db, "session_meta", "memory_block_cache", "TEXT DEFAULT ''");
      ensureColumn(db, "session_meta", "memory_block_count", "INTEGER DEFAULT 0");
      ensureColumn(db, "session_meta", "memory_block_ids", "TEXT DEFAULT ''");
      db.prepare(`UPDATE session_meta SET
                    cached_m0_bytes = NULL,
                    cached_m1_bytes = NULL,
                    cached_m0_project_memory_epoch = NULL,
                    cached_m0_project_user_profile_version = NULL,
                    cached_m0_max_compartment_seq = NULL,
                    cached_m0_max_memory_id = NULL,
                    cached_m0_max_mutation_id = NULL,
                    cached_m0_max_memory_mutation_id = NULL,
                    cached_m0_project_docs_hash = NULL,
                    cached_m0_materialized_at = NULL,
                    cached_m0_session_facts_version = NULL,
                    cached_m0_upgrade_state = NULL,
                    memory_block_cache = '',
                    memory_block_count = 0,
                    memory_block_ids = ''`).run();
    }
  },
  {
    version: 27,
    description: "tags.entry_fingerprint for Pi fallback-tag adoption",
    up: (db) => {
      const hasTags = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tags' LIMIT 1").get();
      if (!hasTags)
        return;
      ensureColumn(db, "tags", "entry_fingerprint", "TEXT");
      db.exec(`CREATE INDEX IF NOT EXISTS idx_tags_pi_adopt
                    ON tags(session_id, entry_fingerprint)
                    WHERE type='message' AND entry_fingerprint IS NOT NULL`);
    }
  },
  {
    version: 28,
    description: "Add git commit sweep coordinator lease/cooldown table",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS git_sweep_coordinator (
                    project_path TEXT PRIMARY KEY,
                    lease_holder TEXT,
                    lease_expires_at INTEGER,
                    last_swept_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_lease_expires
                    ON git_sweep_coordinator(lease_expires_at);
                CREATE INDEX IF NOT EXISTS idx_git_sweep_coordinator_last_swept
                    ON git_sweep_coordinator(last_swept_at);
            `);
    }
  },
  {
    version: 29,
    description: "Add anchor_ordinal to notes (traceback to the conversation tail)",
    up: (db) => {
      const notesExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get();
      if (!notesExists) {
        return;
      }
      const columns = db.prepare("PRAGMA table_info(notes)").all();
      if (!columns.some((column) => column.name === "anchor_ordinal")) {
        db.exec("ALTER TABLE notes ADD COLUMN anchor_ordinal INTEGER");
      }
    }
  },
  {
    version: 30,
    description: "HARD-bust m[0] markers: cached system/tool-set/model identity",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "cached_m0_system_hash", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_tool_set_hash", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_model_key", "TEXT");
      const columns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
      if (columns.has("cached_m0_bytes")) {
        db.prepare(`UPDATE session_meta SET
                        cached_m0_bytes = NULL,
                        cached_m1_bytes = NULL,
                        cached_m0_materialized_at = NULL,
                        cached_m0_system_hash = NULL,
                        cached_m0_tool_set_hash = NULL,
                        cached_m0_model_key = NULL`).run();
      }
    }
  },
  {
    version: 31,
    description: "Nudge redesign: Channel 1 cadence (last_nudge_undropped) + Channel 2 ceiling lease " + "(channel2_nudge_state); zero legacy ctx_reduce-nudge sticky/anchor state (startup heal)",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "last_nudge_undropped", "INTEGER DEFAULT 0");
      ensureColumn(db, "session_meta", "channel2_nudge_state", "TEXT DEFAULT ''");
      const columns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
      if (columns.has("sticky_turn_reminder_text")) {
        db.prepare(`UPDATE session_meta SET
                        sticky_turn_reminder_text = '',
                        sticky_turn_reminder_message_id = '',
                        nudge_anchor_message_id = '',
                        nudge_anchor_text = ''`).run();
      }
    }
  },
  {
    version: 32,
    description: "Protected tail boundary state, usage resolver fields, recovery escape, and drain quota",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "prior_boundary_ordinal", "INTEGER NOT NULL DEFAULT 1");
      ensureColumn(db, "session_meta", "protected_tail_policy_version", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "protected_tail_drain_window_started_at", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "protected_tail_drain_tokens", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "recovery_no_eligible_head_count", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "force_emergency_bypass_window_start", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "force_emergency_bypass_used", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "last_usage_context_limit", "INTEGER NOT NULL DEFAULT 0");
      db.prepare("UPDATE session_meta SET prior_boundary_ordinal = 1 WHERE prior_boundary_ordinal IS NULL OR prior_boundary_ordinal < 1").run();
      db.prepare("UPDATE session_meta SET protected_tail_policy_version = 0 WHERE protected_tail_policy_version IS NULL").run();
      db.prepare("UPDATE session_meta SET protected_tail_drain_window_started_at = 0 WHERE protected_tail_drain_window_started_at IS NULL").run();
      db.prepare("UPDATE session_meta SET protected_tail_drain_tokens = 0 WHERE protected_tail_drain_tokens IS NULL").run();
      db.prepare("UPDATE session_meta SET recovery_no_eligible_head_count = 0 WHERE recovery_no_eligible_head_count IS NULL").run();
      db.prepare("UPDATE session_meta SET force_emergency_bypass_window_start = 0 WHERE force_emergency_bypass_window_start IS NULL").run();
      db.prepare("UPDATE session_meta SET force_emergency_bypass_used = 0 WHERE force_emergency_bypass_used IS NULL").run();
      db.prepare("UPDATE session_meta SET last_usage_context_limit = 0 WHERE last_usage_context_limit IS NULL").run();
    }
  },
  {
    version: 33,
    description: "Compartment chunk embeddings for semantic message-history search",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS compartment_chunk_embeddings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    window_index INTEGER NOT NULL DEFAULT 0,
                    start_ordinal INTEGER NOT NULL,
                    end_ordinal INTEGER NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector BLOB NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(compartment_id, window_index)
                );
                CREATE INDEX IF NOT EXISTS idx_cce_session
                    ON compartment_chunk_embeddings(session_id);
                CREATE INDEX IF NOT EXISTS idx_cce_project_model
                    ON compartment_chunk_embeddings(project_path, model_id);
            `);
    }
  },
  {
    version: 34,
    description: "workspace tables and m[0] workspace fingerprint cache reset",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS workspace_members (
                    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    project_path TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    display_path TEXT NOT NULL,
                    added_at INTEGER NOT NULL,
                    PRIMARY KEY (workspace_id, project_path)
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique
                    ON workspace_members(project_path);
                CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_name
                    ON workspace_members(workspace_id, display_name);
            `);
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta' LIMIT 1").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "cached_m0_workspace_fingerprint", "TEXT");
      const columns = new Set(db.prepare("PRAGMA table_info(session_meta)").all().map((column) => column.name));
      const clears = [
        ["cached_m0_bytes", null],
        ["cached_m1_bytes", null],
        ["cached_m0_project_memory_epoch", null],
        ["cached_m0_workspace_fingerprint", null],
        ["cached_m0_project_user_profile_version", null],
        ["cached_m0_max_compartment_seq", null],
        ["cached_m0_max_memory_id", null],
        ["cached_m0_max_mutation_id", null],
        ["cached_m0_max_memory_mutation_id", null],
        ["cached_m0_project_docs_hash", null],
        ["cached_m0_materialized_at", null],
        ["cached_m0_session_facts_version", null],
        ["cached_m0_upgrade_state", null],
        ["cached_m0_system_hash", null],
        ["cached_m0_tool_set_hash", null],
        ["cached_m0_model_key", null],
        ["cached_m0_last_baseline_end_message_id", null],
        ["memory_block_cache", ""],
        ["memory_block_ids", ""],
        ["memory_block_count", 0]
      ];
      const setClauses = [];
      const values = [];
      for (const [column, value] of clears) {
        if (!columns.has(column))
          continue;
        setClauses.push(`${column} = ?`);
        values.push(value);
      }
      if (setClauses.length > 0) {
        db.prepare(`UPDATE session_meta SET ${setClauses.join(", ")}`).run(...values);
      }
    }
  },
  {
    version: 35,
    description: "workspace per-category share defaults and epoch refresh",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS workspaces (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    share_categories TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'
                );
            `);
      ensureColumn(db, "workspaces", "share_categories", `TEXT NOT NULL DEFAULT '["CONSTRAINTS"]'`);
      db.prepare(`UPDATE workspaces
                    SET share_categories = '["CONSTRAINTS"]'
                  WHERE share_categories IS NULL OR share_categories = ''`).run();
      if (!tableExists2(db, "workspace_members"))
        return;
      const rows = db.prepare(`SELECT DISTINCT project_path AS identity
                       FROM workspace_members
                      WHERE project_path IS NOT NULL AND project_path <> ''
                      ORDER BY project_path ASC`).all();
      const identities = rows.map((row) => typeof row.identity === "string" ? row.identity : "").filter((identity) => identity.length > 0);
      if (identities.length > 0) {
        bumpEpochsForWorkspaceMemberSet(db, identities, Date.now());
      }
    }
  },
  {
    version: 36,
    description: "session project ownership map for compartment chunk backfill scoping",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS session_projects (
                    session_id TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    project_path TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, harness)
                );
                CREATE INDEX IF NOT EXISTS idx_session_projects_project
                    ON session_projects(project_path);
            `);
      const hasChunkTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='compartment_chunk_embeddings'").get();
      if (hasChunkTable) {
        db.exec(`
                    INSERT OR IGNORE INTO session_projects (session_id, harness, project_path, updated_at)
                    SELECT session_id, harness, MIN(project_path), 0
                    FROM compartment_chunk_embeddings
                    GROUP BY session_id, harness
                    HAVING COUNT(DISTINCT project_path) = 1;
                `);
      }
    }
  },
  {
    version: 37,
    description: "emergency drain catch-up latch + historian drain failure backoff",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "emergency_drain_active", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "session_meta", "historian_drain_failure_at", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 38,
    description: "durable transform decisions for cache-event cause attribution",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS transform_decisions (
                    session_id         TEXT    NOT NULL,
                    harness            TEXT    NOT NULL DEFAULT 'opencode',
                    message_id         TEXT    NOT NULL,
                    ts_ms              INTEGER NOT NULL,
                    decision           TEXT    NOT NULL,
                    materialized       INTEGER NOT NULL DEFAULT 0,
                    materialize_reason TEXT,
                    emergency          INTEGER NOT NULL DEFAULT 0,
                    dropped_tokens     INTEGER NOT NULL DEFAULT 0,
                    dropped_count      INTEGER NOT NULL DEFAULT 0,
                    input_tokens       INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (session_id, harness, message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_transform_decisions_session_harness
                    ON transform_decisions(session_id, harness);
            `);
    }
  },
  {
    version: 39,
    description: "persist compaction marker target end message id",
    up: (db) => {
      const hasSessionMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_meta'").get();
      if (!hasSessionMeta)
        return;
      ensureColumn(db, "session_meta", "compaction_marker_state", "TEXT DEFAULT ''");
      ensureColumn(db, "session_meta", "compaction_marker_target_end_message_id", "TEXT");
      db.exec(`
                UPDATE session_meta
                SET compaction_marker_target_end_message_id = json_extract(compaction_marker_state, '$.targetEndMessageId')
                WHERE compaction_marker_target_end_message_id IS NULL
                  AND COALESCE(compaction_marker_state, '') != ''
                  AND json_valid(compaction_marker_state)
                  AND typeof(json_extract(compaction_marker_state, '$.targetEndMessageId')) = 'text'
            `);
    }
  },
  {
    version: 40,
    description: "index Pi fallback tool owners for stable-id cutover",
    up: (db) => {
      if (!tableExists2(db, "tags"))
        return;
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_tags_pi_fallback_tool_owner
                ON tags(session_id, tool_owner_message_id)
                WHERE type='tool';
            `);
    }
  },
  {
    version: 41,
    description: "key detected context limits by model",
    up: (db) => {
      if (!tableExists2(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "detected_context_limit_model_key", "TEXT");
    }
  },
  {
    version: 42,
    description: "per-task dreamer scheduling state (Dreamer v2 A+B)",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS task_schedule_state (
                    project_path  TEXT    NOT NULL,
                    task          TEXT    NOT NULL,
                    last_run_at   INTEGER,
                    next_due_at   INTEGER,
                    schedule      TEXT,
                    last_status   TEXT,
                    last_error    TEXT,
                    retry_count   INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (project_path, task)
                );
                CREATE INDEX IF NOT EXISTS idx_task_schedule_due
                    ON task_schedule_state(next_due_at);
            `);
    }
  },
  {
    version: 43,
    description: "memory verification side table and verify watermarks",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS memory_verifications (
                    memory_id    INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                    file_path    TEXT NOT NULL,
                    verified_at  INTEGER NOT NULL,
                    PRIMARY KEY (memory_id, file_path)
                );
                CREATE INDEX IF NOT EXISTS idx_memory_verifications_memory
                    ON memory_verifications(memory_id);
            `);
      if (tableExists2(db, "task_schedule_state")) {
        ensureColumn(db, "task_schedule_state", "last_checked_commit", "TEXT");
        ensureColumn(db, "task_schedule_state", "last_broad_run_at", "INTEGER");
      }
    }
  },
  {
    version: 44,
    description: "memory classification scope and shareability columns",
    up: (db) => {
      if (!tableExists2(db, "memories"))
        return;
      ensureColumn(db, "memories", "scope", "TEXT NOT NULL DEFAULT 'project'");
      ensureColumn(db, "memories", "shareable", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 45,
    description: "retrospective content watermark and processed-window idempotence",
    up: (db) => {
      if (tableExists2(db, "task_schedule_state")) {
        ensureColumn(db, "task_schedule_state", "retrospective_watermark_ms", "INTEGER");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS retrospective_processed_windows (
                    project_path TEXT NOT NULL,
                    window_key   TEXT NOT NULL,
                    processed_at INTEGER NOT NULL,
                    PRIMARY KEY (project_path, window_key)
                );
            `);
    }
  },
  {
    version: 46,
    description: "Primers v1 candidate and promoted primer storage",
    up: (db) => {
      db.exec(`
                CREATE TABLE IF NOT EXISTS primer_candidates (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    session_id TEXT NOT NULL,
                    question TEXT NOT NULL,
                    normalized_question TEXT NOT NULL,
                    source_compartment_start INTEGER,
                    source_compartment_end INTEGER,
                    source_start_message_id TEXT NOT NULL DEFAULT '',
                    source_end_message_id TEXT NOT NULL DEFAULT '',
                    source_message_time INTEGER NOT NULL,
                    question_embedding BLOB,
                    question_embedding_model_id TEXT,
                    created_at INTEGER NOT NULL,
                    UNIQUE(project_path, harness, session_id, source_start_message_id, source_end_message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_project_time
                    ON primer_candidates(project_path, source_message_time);
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_session
                    ON primer_candidates(session_id, harness);
                CREATE INDEX IF NOT EXISTS idx_primer_candidates_embedding_model
                    ON primer_candidates(project_path, question_embedding_model_id);

                CREATE TABLE IF NOT EXISTS primers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_path TEXT NOT NULL,
                    question TEXT NOT NULL,
                    question_embedding BLOB,
                    question_embedding_model_id TEXT,
                    answer TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
                    total_support INTEGER NOT NULL DEFAULT 0,
                    last_observed_at INTEGER,
                    answer_refreshed_at INTEGER,
                    source_candidate_ids TEXT NOT NULL DEFAULT '[]',
                    source_candidate_provenance TEXT,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_primers_project_status_observed
                    ON primers(project_path, status, last_observed_at DESC);
                CREATE INDEX IF NOT EXISTS idx_primers_embedding_model
                    ON primers(project_path, question_embedding_model_id);

                CREATE VIRTUAL TABLE IF NOT EXISTS primers_fts USING fts5(
                    question,
                    answer,
                    project_path UNINDEXED,
                    content='primers',
                    content_rowid='id',
                    tokenize='porter unicode61'
                );
                CREATE TRIGGER IF NOT EXISTS primers_ai AFTER INSERT ON primers BEGIN
                    INSERT INTO primers_fts(rowid, question, answer, project_path)
                    VALUES (new.id, new.question, new.answer, new.project_path);
                END;
                CREATE TRIGGER IF NOT EXISTS primers_ad AFTER DELETE ON primers BEGIN
                    INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
                    VALUES ('delete', old.id, old.question, old.answer, old.project_path);
                END;
                CREATE TRIGGER IF NOT EXISTS primers_au AFTER UPDATE ON primers BEGIN
                    INSERT INTO primers_fts(primers_fts, rowid, question, answer, project_path)
                    VALUES ('delete', old.id, old.question, old.answer, old.project_path);
                    INSERT INTO primers_fts(rowid, question, answer, project_path)
                    VALUES (new.id, new.question, new.answer, new.project_path);
                END;
            `);
    }
  },
  {
    version: 47,
    description: "compiled smart-note checks and runtime policy state",
    up: (db) => {
      if (!tableExists2(db, "notes"))
        return;
      ensureColumn(db, "notes", "compiled_check", "TEXT");
      ensureColumn(db, "notes", "manifest_json", "TEXT");
      ensureColumn(db, "notes", "check_hash", "TEXT");
      ensureColumn(db, "notes", "check_cron", "TEXT");
      ensureColumn(db, "notes", "check_version", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "notes", "check_status", "TEXT NOT NULL DEFAULT 'uncompiled'");
      ensureColumn(db, "notes", "check_failure_count", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "notes", "check_network_failure_count", "INTEGER NOT NULL DEFAULT 0");
      ensureColumn(db, "notes", "check_quarantined_until", "INTEGER");
      ensureColumn(db, "notes", "check_next_due_at", "INTEGER");
      ensureColumn(db, "notes", "check_compiled_at", "INTEGER");
      ensureColumn(db, "notes", "check_false_since_at", "INTEGER");
      ensureColumn(db, "notes", "check_last_liveness_at", "INTEGER");
      ensureColumn(db, "notes", "policy_version", "INTEGER NOT NULL DEFAULT 1");
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_notes_smart_checks_due
                    ON notes(project_path, check_status, check_next_due_at)
                    WHERE type = 'smart' AND status = 'pending';
                CREATE INDEX IF NOT EXISTS idx_notes_smart_checks_liveness
                    ON notes(project_path, check_false_since_at, check_last_liveness_at)
                    WHERE type = 'smart' AND status = 'pending';
            `);
    }
  },
  {
    version: 48,
    description: "DreamerV2 rework: memory→file mapping vs verification split, classify marker",
    up: (db) => {
      if (tableExists2(db, "memory_verifications")) {
        ensureColumn(db, "memory_verifications", "mapped_at", "INTEGER NOT NULL DEFAULT 0");
      }
      if (tableExists2(db, "memories")) {
        ensureColumn(db, "memories", "classified_at", "INTEGER");
      }
    }
  },
  {
    version: 49,
    description: "per-model embedding coexistence and active identity tracking",
    up: (db) => {
      if (tableExists2(db, "memory_embeddings")) {
        db.exec(`
                    UPDATE memory_embeddings
                    SET model_id = 'legacy:unknown'
                    WHERE model_id IS NULL;
                `);
        if (tableExists2(db, "memories")) {
          db.exec(`
                        DELETE FROM memory_embeddings
                        WHERE memory_id NOT IN (SELECT id FROM memories);
                    `);
        }
        db.exec(`
                    DROP TABLE IF EXISTS memory_embeddings_v49_new;
                    CREATE TABLE memory_embeddings_v49_new (
                        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        PRIMARY KEY(memory_id, model_id)
                    );
                    INSERT INTO memory_embeddings_v49_new (memory_id, embedding, model_id)
                    SELECT memory_id, embedding, model_id
                    FROM memory_embeddings;
                    DROP TABLE memory_embeddings;
                    ALTER TABLE memory_embeddings_v49_new RENAME TO memory_embeddings;
                `);
        assertForeignKeyIntegrity(db, "memory_embeddings");
      }
      if (tableExists2(db, "git_commit_embeddings")) {
        if (tableExists2(db, "git_commits")) {
          db.exec(`
                        DELETE FROM git_commit_embeddings
                        WHERE sha NOT IN (SELECT sha FROM git_commits);
                    `);
        }
        db.exec(`
                    DROP TABLE IF EXISTS git_commit_embeddings_v49_new;
                    CREATE TABLE git_commit_embeddings_v49_new (
                        sha TEXT NOT NULL,
                        embedding BLOB NOT NULL,
                        model_id TEXT NOT NULL,
                        created_at INTEGER NOT NULL,
                        PRIMARY KEY(sha, model_id),
                        FOREIGN KEY(sha) REFERENCES git_commits(sha) ON DELETE CASCADE
                    );
                    INSERT INTO git_commit_embeddings_v49_new (sha, embedding, model_id, created_at)
                    SELECT sha, embedding, model_id, created_at
                    FROM git_commit_embeddings;
                    DROP TABLE git_commit_embeddings;
                    ALTER TABLE git_commit_embeddings_v49_new RENAME TO git_commit_embeddings;
                `);
        assertForeignKeyIntegrity(db, "git_commit_embeddings");
      }
      if (tableExists2(db, "compartment_chunk_embeddings")) {
        if (tableExists2(db, "compartments")) {
          db.exec(`
                        DELETE FROM compartment_chunk_embeddings
                        WHERE compartment_id NOT IN (SELECT id FROM compartments);
                    `);
        }
        db.exec(`
                    DROP INDEX IF EXISTS idx_cce_session;
                    DROP INDEX IF EXISTS idx_cce_project_model;
                    DROP TABLE IF EXISTS compartment_chunk_embeddings_v49_new;
                    CREATE TABLE compartment_chunk_embeddings_v49_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        compartment_id INTEGER NOT NULL REFERENCES compartments(id) ON DELETE CASCADE,
                        session_id TEXT NOT NULL,
                        project_path TEXT NOT NULL,
                        harness TEXT NOT NULL DEFAULT 'opencode',
                        window_index INTEGER NOT NULL DEFAULT 0,
                        start_ordinal INTEGER NOT NULL,
                        end_ordinal INTEGER NOT NULL,
                        chunk_hash TEXT NOT NULL,
                        model_id TEXT NOT NULL,
                        dims INTEGER NOT NULL,
                        vector BLOB NOT NULL,
                        created_at INTEGER NOT NULL,
                        UNIQUE(compartment_id, model_id, window_index)
                    );
                    INSERT INTO compartment_chunk_embeddings_v49_new (
                        id, compartment_id, session_id, project_path, harness, window_index,
                        start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                    )
                    SELECT id, compartment_id, session_id, project_path, harness, window_index,
                           start_ordinal, end_ordinal, chunk_hash, model_id, dims, vector, created_at
                    FROM compartment_chunk_embeddings;
                    DROP TABLE compartment_chunk_embeddings;
                    ALTER TABLE compartment_chunk_embeddings_v49_new RENAME TO compartment_chunk_embeddings;
                    CREATE INDEX IF NOT EXISTS idx_cce_session ON compartment_chunk_embeddings(session_id);
                    CREATE INDEX IF NOT EXISTS idx_cce_project_model ON compartment_chunk_embeddings(project_path, model_id);
                `);
        assertForeignKeyIntegrity(db, "compartment_chunk_embeddings");
      }
      db.exec(`
                CREATE TABLE IF NOT EXISTS embedding_identity_active (
                    project_path TEXT NOT NULL,
                    scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
                    model_id TEXT NOT NULL,
                    last_active_at INTEGER NOT NULL,
                    PRIMARY KEY(project_path, scope, model_id)
                );
            `);
    }
  },
  {
    version: 50,
    description: "add durable ctx-wrapup session marker",
    up(db) {
      if (tableExists2(db, "session_meta")) {
        ensureColumn(db, "session_meta", "wrapup_in_progress_state", "TEXT");
      }
    }
  },
  {
    version: 51,
    description: "version tool-owner backfill state and repair legacy NULL session metadata",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS tool_owner_backfill_state (
                    session_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'skipped')),
                    started_at INTEGER,
                    lease_expires_at INTEGER,
                    completed_at INTEGER,
                    last_error TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_tool_owner_backfill_state_status
                    ON tool_owner_backfill_state(status);
            `);
      healAllNullColumns(db);
    }
  },
  {
    version: 52,
    description: "persist emergency recovery origin",
    up(db) {
      if (tableExists2(db, "session_meta")) {
        ensureColumn(db, "session_meta", "emergency_recovery_origin", "TEXT DEFAULT ''");
      }
    }
  },
  {
    version: 53,
    description: "add Synapse batch, shadow, and measurement storage",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS embedding_registrations (
                    project_path TEXT PRIMARY KEY,
                    provider_identity TEXT NOT NULL DEFAULT '',
                    model_id TEXT NOT NULL DEFAULT '',
                    chunk_model_id TEXT NOT NULL DEFAULT '',
                    fingerprint TEXT NOT NULL DEFAULT '',
                    table_epoch INTEGER NOT NULL DEFAULT 0,
                    dims INTEGER NOT NULL DEFAULT 0,
                    provenance_json TEXT NOT NULL DEFAULT '{}',
                    generation INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS synapse_batch_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL DEFAULT '',
                    scope TEXT NOT NULL DEFAULT '',
                    manifest_json TEXT NOT NULL DEFAULT '{}',
                    request_key TEXT NOT NULL DEFAULT '',
                    job_id TEXT,
                    cursor TEXT,
                    status TEXT NOT NULL DEFAULT 'pending',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(session_id, request_key)
                );
                CREATE INDEX IF NOT EXISTS idx_synapse_batch_ledger_session
                    ON synapse_batch_ledger(session_id, updated_at);
                CREATE TABLE IF NOT EXISTS shadow_embedding_registrations (
                    project_path TEXT NOT NULL,
                    scope TEXT NOT NULL CHECK(scope IN ('memory', 'commit', 'chunk')),
                    model_id TEXT NOT NULL,
                    generation INTEGER NOT NULL DEFAULT 0,
                    fingerprint TEXT NOT NULL DEFAULT '',
                    table_epoch INTEGER NOT NULL DEFAULT 0,
                    dims INTEGER NOT NULL DEFAULT 0,
                    provenance_json TEXT NOT NULL DEFAULT '{}',
                    updated_at INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, scope, model_id)
                );
                CREATE TABLE IF NOT EXISTS embedding_measurement_corpus (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    project_path TEXT NOT NULL DEFAULT '',
                    dedup_key TEXT NOT NULL DEFAULT '',
                    cohort_key TEXT NOT NULL DEFAULT '',
                    query_text_hash TEXT NOT NULL DEFAULT '',
                    primary_result_ids_json TEXT NOT NULL DEFAULT '[]',
                    shadow_result_ids_json TEXT NOT NULL DEFAULT '[]',
                    primary_latency_ms INTEGER,
                    shadow_latency_ms INTEGER,
                    primary_failed INTEGER NOT NULL DEFAULT 0,
                    shadow_failed INTEGER NOT NULL DEFAULT 0,
                    primary_model_id TEXT NOT NULL DEFAULT '',
                    shadow_model_id TEXT NOT NULL DEFAULT '',
                    primary_fingerprint TEXT NOT NULL DEFAULT '',
                    shadow_fingerprint TEXT NOT NULL DEFAULT '',
                    primary_epoch INTEGER NOT NULL DEFAULT 0,
                    shadow_epoch INTEGER NOT NULL DEFAULT 0,
                    corpus_hash TEXT NOT NULL DEFAULT '',
                    coverage_json TEXT NOT NULL DEFAULT '{}',
                    created_at INTEGER NOT NULL DEFAULT 0,
                    UNIQUE(dedup_key, cohort_key)
                );
                CREATE INDEX IF NOT EXISTS idx_embedding_measurement_session
                    ON embedding_measurement_corpus(session_id, created_at);
            `);
    }
  },
  {
    version: 54,
    description: "add authority identity, managed-write guards, and mirror cursors",
    up(db) {
      const memoriesPresent = tableExists2(db, "memories");
      const notesPresent = tableExists2(db, "notes");
      db.exec(`
                CREATE TABLE IF NOT EXISTS context_store_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authority_managed (
                    project_path TEXT PRIMARY KEY,
                    context_store_uuid TEXT NOT NULL,
                    marked_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS authority_repair_pending (
                    project_path TEXT PRIMARY KEY,
                    started_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS mirror_identity (
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id),
                    UNIQUE(domain, context_row_id)
                );
                CREATE TABLE IF NOT EXISTS mirror_cursors (
                    domain TEXT PRIMARY KEY CHECK(domain IN ('memories', 'notes')),
                    cursor INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS context_privilege_state (
                    id INTEGER PRIMARY KEY CHECK(id = 1),
                    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1))
                );
            `);
      if (memoriesPresent) {
        db.exec(`
                DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                DROP TRIGGER IF EXISTS memories_authority_guard_update;
                DROP TRIGGER IF EXISTS memories_authority_guard_delete;
                CREATE TRIGGER memories_authority_guard_insert
                BEFORE INSERT ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                CREATE TRIGGER memories_authority_guard_update
                BEFORE UPDATE ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                CREATE TRIGGER memories_authority_guard_delete
                BEFORE DELETE ON memories
                 WHEN (
                     EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                     OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                 ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module');
                END;
                `);
      }
      if (notesPresent) {
        db.exec(`
                DROP TRIGGER IF EXISTS notes_authority_guard_insert;
                DROP TRIGGER IF EXISTS notes_authority_guard_update;
                DROP TRIGGER IF EXISTS notes_authority_guard_delete;
                CREATE TRIGGER notes_authority_guard_insert
                BEFORE INSERT ON notes
                 WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                   AND (
                       EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)
                   ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                CREATE TRIGGER notes_authority_guard_update
                BEFORE UPDATE ON notes
                WHEN (
                     (OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)))
                     OR
                     (NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path)))
                ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                CREATE TRIGGER notes_authority_guard_delete
                BEFORE DELETE ON notes
                 WHEN OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                   AND (
                       EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                   ) AND COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0
                BEGIN
                    SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module');
                END;
                `);
      }
    }
  },
  {
    version: 55,
    description: "make managed-write privilege connection-local",
    up(db) {
      const memoriesPresent = tableExists2(db, "memories");
      const notesPresent = tableExists2(db, "notes");
      const native = db;
      const privilegeCheck = typeof native.function === "function" || typeof native.createFunction === "function" ? "mc_privileged_writer() = 0" : "COALESCE((SELECT enabled FROM context_privilege_state WHERE id = 1), 0) = 0";
      if (memoriesPresent) {
        db.exec(`
                    DROP TRIGGER IF EXISTS memories_authority_guard_insert;
                    DROP TRIGGER IF EXISTS memories_authority_guard_update;
                    DROP TRIGGER IF EXISTS memories_authority_guard_delete;
                    CREATE TRIGGER memories_authority_guard_insert
                    BEFORE INSERT ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                    CREATE TRIGGER memories_authority_guard_update
                    BEFORE UPDATE ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                    CREATE TRIGGER memories_authority_guard_delete
                    BEFORE DELETE ON memories
                    WHEN (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                       OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db memory writes are managed by the Rust module'); END;
                `);
      }
      if (notesPresent) {
        db.exec(`
                    DROP TRIGGER IF EXISTS notes_authority_guard_insert;
                    DROP TRIGGER IF EXISTS notes_authority_guard_update;
                    DROP TRIGGER IF EXISTS notes_authority_guard_delete;
                    CREATE TRIGGER notes_authority_guard_insert
                    BEFORE INSERT ON notes
                    WHEN NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                    CREATE TRIGGER notes_authority_guard_update
                    BEFORE UPDATE ON notes
                    WHEN ((OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                            AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                              OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path)))
                       OR (NEW.type = 'smart' AND NEW.project_path IS NOT NULL
                            AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = NEW.project_path)
                              OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = NEW.project_path))))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                    CREATE TRIGGER notes_authority_guard_delete
                    BEFORE DELETE ON notes
                    WHEN OLD.type = 'smart' AND OLD.project_path IS NOT NULL
                      AND (EXISTS (SELECT 1 FROM authority_managed WHERE project_path = OLD.project_path)
                        OR EXISTS (SELECT 1 FROM authority_repair_pending WHERE project_path = OLD.project_path))
                      AND ${privilegeCheck}
                    BEGIN SELECT RAISE(ABORT, 'context.db smart-note writes are managed by the Rust module'); END;
                `);
      }
    }
  },
  {
    version: 56,
    description: "record authority capture bounds and pending mirror references",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS authority_capture_bounds (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    max_rowid INTEGER NOT NULL,
                    data_version INTEGER NOT NULL,
                    captured_at INTEGER NOT NULL,
                    PRIMARY KEY(project_path, domain)
                );
                CREATE TABLE IF NOT EXISTS mirror_pending_references (
                    domain TEXT NOT NULL CHECK(domain = 'memories'),
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    target_module_row_id INTEGER NOT NULL,
                    PRIMARY KEY(domain, module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_pending_reference_target
                    ON mirror_pending_references(domain, module_project, target_module_row_id);
                CREATE TABLE IF NOT EXISTS mirror_note_revisions (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    context_row_id INTEGER NOT NULL,
                    status_version INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(module_project, module_row_id),
                    UNIQUE(context_row_id)
                );
            `);
      installLatestAuthorityTriggers(db);
    }
  },
  {
    version: 57,
    description: "domain mutation epoch for authority capture bounds",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS domain_mutation_epoch (
                    project_path TEXT NOT NULL,
                    domain TEXT NOT NULL CHECK(domain IN ('memories', 'notes')),
                    epoch INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(project_path, domain)
                );
            `);
      if (tableExists2(db, "authority_capture_bounds")) {
        ensureColumn(db, "authority_capture_bounds", "mutation_epoch", "INTEGER NOT NULL DEFAULT 0");
      }
    }
  },
  {
    version: 58,
    description: "track live module memory identities during mirror replay",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_live_memory_rows (
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    PRIMARY KEY(module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_live_memory_content
                    ON mirror_live_memory_rows(module_project, category, normalized_hash);
                CREATE TABLE IF NOT EXISTS mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at)
                VALUES ('memories', 'pending_check', 0);
            `);
    }
  },
  {
    version: 59,
    description: "stage paged live memory resnapshots before atomic replacement",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_live_staging (
                    generation TEXT NOT NULL,
                    module_project TEXT NOT NULL,
                    module_row_id INTEGER NOT NULL,
                    category TEXT NOT NULL,
                    normalized_hash TEXT NOT NULL,
                    PRIMARY KEY(generation, module_project, module_row_id)
                );
                CREATE INDEX IF NOT EXISTS idx_mirror_live_staging_generation
                    ON mirror_live_staging(generation);
            `);
    }
  },
  {
    version: 60,
    description: "persist the owning live memory resnapshot generation",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mirror_resnapshot_state (
                    domain TEXT PRIMARY KEY CHECK(domain = 'memories'),
                    status TEXT NOT NULL CHECK(status IN ('pending_check', 'resnapshotting', 'complete')),
                    updated_at INTEGER NOT NULL
                );
            `);
      db.exec("INSERT OR IGNORE INTO mirror_resnapshot_state(domain, status, updated_at) VALUES ('memories', 'pending_check', 0)");
      ensureColumn(db, "mirror_resnapshot_state", "generation", "TEXT");
    }
  },
  {
    version: 61,
    description: "retain complete memory snapshots for mirror healing",
    up(db) {
      ensureColumn(db, "mirror_live_memory_rows", "full_row_snapshot", "TEXT");
      ensureColumn(db, "mirror_live_staging", "full_row_snapshot", "TEXT");
      db.prepare(`UPDATE mirror_resnapshot_state
                    SET status = 'pending_check', generation = NULL, updated_at = ?
                  WHERE domain = 'memories'
                    AND status = 'complete'
                    AND NOT EXISTS (
                        SELECT 1 FROM schema_migrations WHERE version = 61
                    )`).run(Date.now());
    }
  },
  {
    version: 62,
    description: "durable row-level project identity merge audit log",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS identity_merge_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_identity TEXT NOT NULL,
                    to_identity TEXT NOT NULL,
                    table_name TEXT NOT NULL,
                    row_id TEXT NOT NULL,
                    action TEXT NOT NULL,
                    target_row_id TEXT,
                    merged_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_identity_merge_log_identities
                    ON identity_merge_log(from_identity, to_identity, merged_at);
                CREATE INDEX IF NOT EXISTS idx_identity_merge_log_table_row
                    ON identity_merge_log(table_name, row_id);
            `);
    }
  },
  {
    version: 63,
    description: "Add anchor_block_id to notes (module note mirror writes it)",
    up(db) {
      if (!tableExists2(db, "notes"))
        return;
      const columns = db.prepare("PRAGMA table_info(notes)").all();
      if (!columns.some((column) => column.name === "anchor_block_id")) {
        db.exec("ALTER TABLE notes ADD COLUMN anchor_block_id TEXT");
      }
    }
  },
  {
    version: 64,
    description: "store project-scoped rendered memory mural",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS mural_manifest (
                    project_path TEXT PRIMARY KEY,
                    image BLOB NOT NULL,
                    content_hash TEXT NOT NULL,
                    rendered_at INTEGER NOT NULL,
                    model TEXT,
                    memory_ids_json TEXT NOT NULL DEFAULT '[]',
                    width INTEGER NOT NULL DEFAULT 1092,
                    height INTEGER NOT NULL DEFAULT 1092
                );
            `);
      ensureColumn(db, "mural_manifest", "model", "TEXT");
      ensureColumn(db, "mural_manifest", "memory_ids_json", "TEXT NOT NULL DEFAULT '[]'");
      ensureColumn(db, "mural_manifest", "width", "INTEGER NOT NULL DEFAULT 1092");
      ensureColumn(db, "mural_manifest", "height", "INTEGER NOT NULL DEFAULT 1092");
    }
  },
  {
    version: 65,
    description: "Add per-memory mural cue columns for the deterministic cue-compression cutover",
    up(db) {
      if (!tableExists2(db, "memories"))
        return;
      ensureColumn(db, "memories", "mural_cue", "TEXT");
      ensureColumn(db, "memories", "mural_cue_hash", "TEXT");
      ensureColumn(db, "memories", "mural_cue_at", "INTEGER");
    }
  },
  {
    version: 66,
    description: "bound per-session historian upgrade reminders",
    up(db) {
      if (!tableExists2(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "upgrade_reminder_last_sent_at", "INTEGER");
      ensureColumn(db, "session_meta", "upgrade_reminder_count", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 67,
    description: "persist the frozen mural payload with each cached m0 baseline",
    up(db) {
      if (!tableExists2(db, "session_meta"))
        return;
      ensureColumn(db, "session_meta", "cached_m0_mural_data_url", "TEXT");
      ensureColumn(db, "session_meta", "cached_m0_mural_hash", "TEXT");
    }
  },
  {
    version: 68,
    description: "converge message FTS deletions and same-ID source revisions",
    up(db) {
      db.exec(`
                CREATE TABLE IF NOT EXISTS message_history_source (
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    message_ordinal INTEGER NOT NULL,
                    source_version TEXT NOT NULL,
                    normalized_content_hash TEXT NOT NULL,
                    role TEXT NOT NULL,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY(session_id, message_id)
                );
                CREATE INDEX IF NOT EXISTS idx_message_history_source_session_ordinal
                    ON message_history_source(session_id, message_ordinal);

                CREATE TABLE IF NOT EXISTS pending_session_cleanup (
                    session_id TEXT PRIMARY KEY,
                    harness TEXT NOT NULL DEFAULT 'opencode',
                    requested_at INTEGER NOT NULL,
                    last_attempt_at INTEGER
                );

                CREATE TABLE IF NOT EXISTS message_history_orphan_sweep (
                    harness TEXT PRIMARY KEY,
                    cursor_session_id TEXT NOT NULL DEFAULT '',
                    last_swept_at INTEGER
                );
            `);
      if (tableExists2(db, "message_history_index")) {
        const columns = new Set(db.prepare("PRAGMA table_info(message_history_index)").all().map((column) => column.name));
        if (columns.has("session_id") && columns.has("harness") && columns.has("updated_at")) {
          db.exec(`
                        CREATE INDEX IF NOT EXISTS idx_message_history_index_orphan_sweep
                            ON message_history_index(harness, session_id, updated_at);
                    `);
        }
      }
    }
  },
  {
    version: 69,
    description: "index visibility mutation discovery and target loading",
    up(db) {
      if (!tableExists2(db, "memory_mutation_log"))
        return;
      db.exec(`
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_visibility
                    ON memory_mutation_log(project_path, category, id, target_memory_id);
                CREATE INDEX IF NOT EXISTS idx_memory_mutation_log_target
                    ON memory_mutation_log(project_path, target_memory_id, id);
            `);
    }
  },
  {
    version: 70,
    description: "heal legacy compartments stranded by mismatched tier closing tags (issue #246)",
    up(db) {
      healMismatchedTierClose(db, "compartments", true);
      healMismatchedTierClose(db, "recomp_compartments", false);
    }
  },
  {
    version: 71,
    description: "rebuild authority guard triggers to the durable state-table form (issue #253)",
    up(db) {
      installLatestAuthorityTriggers(db);
    }
  },
  {
    version: 72,
    description: "add per-session compaction mode record column (issue #266)",
    up(db) {
      if (tableExists2(db, "session_meta")) {
        ensureColumn(db, "session_meta", "compaction_mode_record", "TEXT");
      }
    }
  },
  {
    version: 73,
    description: "persist the last successful todowrite permission verdict",
    up(db) {
      if (tableExists2(db, "session_meta")) {
        ensureColumn(db, "session_meta", "todo_permission_denied", "INTEGER NOT NULL DEFAULT 2");
      }
    }
  },
  {
    version: 74,
    description: "persist detected context-limit provenance",
    up(db) {
      if (tableExists2(db, "session_meta")) {
        ensureColumn(db, "session_meta", "detected_context_limit_provenance", "TEXT NOT NULL DEFAULT 'unknown'");
      }
    }
  },
  {
    version: 75,
    description: "persist mural cue validation rejection latches",
    up(db) {
      if (!tableExists2(db, "memories"))
        return;
      ensureColumn(db, "memories", "mural_cue_rejection_count", "INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    version: 76,
    description: "persist retina provider compilation for smart-note conditions",
    up(db) {
      if (!tableExists2(db, "notes"))
        return;
      ensureColumn(db, "notes", "compiled_provider", "TEXT");
      ensureColumn(db, "notes", "compiled_config", "TEXT");
      ensureColumn(db, "notes", "compiled_at", "INTEGER");
      ensureColumn(db, "notes", "compile_status", "TEXT CHECK(compile_status IN ('compiled', 'plain', 'refused'))");
    }
  },
  {
    version: 77,
    description: "persist scoped provenance for promoted user memories and primers",
    up(db) {
      if (tableExists2(db, "user_memories")) {
        ensureColumn(db, "user_memories", "source_candidate_provenance", "TEXT");
      }
      if (tableExists2(db, "primers")) {
        ensureColumn(db, "primers", "source_candidate_provenance", "TEXT");
      }
    }
  }
];
var LATEST_MIGRATION_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

// ../plugin/src/hooks/magic-context/read-session-formatting.ts
import { createRequire } from "node:module";

// ../plugin/src/shared/commit-detection.ts
var HASH_HEX = "[0-9a-f]{7,12}";
var COMMIT_HASH_TEST_PATTERN = new RegExp(`\\b${HASH_HEX}\\b`, "i");
var COMMIT_VERB_PATTERN = /\b(?:commit(?:ted|ting|s)?|cherry-?pick(?:ed|ing|s)?|merge[ds]?|merging|rebas(?:e|ed|es|ing))\b/i;
function createCommitHashExtractPattern() {
  return new RegExp(`\`?\\b(${HASH_HEX})\\b\`?`, "gi");
}

// ../plugin/src/shared/internal-initiator-marker.ts
var OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->";

// ../plugin/src/shared/system-directive.ts
var SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";
function isSystemDirective(text) {
  return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}
function removeSystemReminders(text) {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "").trim();
}

// ../plugin/src/hooks/magic-context/read-session-formatting.ts
var MAX_COMMITS_PER_BLOCK = 5;
function hasMeaningfulUserText(parts) {
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const candidate = part;
    if (candidate.type !== "text" || typeof candidate.text !== "string")
      continue;
    if (candidate.ignored === true)
      continue;
    const cleaned = removeSystemReminders(candidate.text).replace(OMO_INTERNAL_INITIATOR_MARKER, "").trim();
    if (!cleaned)
      continue;
    if (isSystemDirective(cleaned))
      continue;
    return true;
  }
  return false;
}
function extractTexts(parts) {
  const texts = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0) {
      texts.push(p.text.trim());
    }
  }
  return texts;
}
function extractToolCallSummaries(parts) {
  const summaries = [];
  for (const part of parts) {
    if (part === null || typeof part !== "object")
      continue;
    const p = part;
    if (p.type !== "tool" || typeof p.tool !== "string")
      continue;
    const state = p.state;
    if (!state || typeof state !== "object")
      continue;
    const input = state.input;
    const metadata = state.metadata;
    const description = input && typeof input.description === "string" && input.description || metadata && typeof metadata.description === "string" && metadata.description;
    if (description) {
      summaries.push(`TC: ${description}`);
      continue;
    }
    const toolName = p.tool;
    const keyArg = extractKeyArg(toolName, input);
    summaries.push(keyArg ? `TC: ${toolName}(${keyArg})` : `TC: ${toolName}`);
  }
  return summaries;
}
function extractKeyArg(_toolName, input) {
  if (!input)
    return null;
  if (typeof input.filePath === "string")
    return truncateArg(input.filePath);
  if (typeof input.path === "string")
    return truncateArg(input.path);
  if (typeof input.pattern === "string")
    return truncateArg(input.pattern);
  if (typeof input.query === "string")
    return truncateArg(input.query);
  if (typeof input.symbol === "string")
    return input.symbol;
  if (typeof input.module === "string")
    return input.module;
  if (typeof input.action === "string")
    return input.action;
  return null;
}
function truncateArg(value, maxLen = 60) {
  if (value.length <= maxLen)
    return value;
  return `${value.slice(0, maxLen)}…`;
}
var tokenizer;
var tokenizerLoadAttempted = false;
var tokenizerWarningSent = false;
function constructTokenizer(tokenizerModule, claudeEncoding) {
  const typedModule = tokenizerModule;
  const Tokenizer = typedModule.default ?? typedModule.Tokenizer;
  if (!Tokenizer) {
    throw new Error("ai-tokenizer does not expose a Tokenizer constructor");
  }
  return new Tokenizer(claudeEncoding);
}
function loadTokenizer() {
  const requireFromThisModule = createRequire(import.meta.url);
  return constructTokenizer(requireFromThisModule("ai-" + "tokenizer"), requireFromThisModule("ai-tokenizer/encoding/" + "claude"));
}
function warnTokenizerFallback(error) {
  if (tokenizerWarningSent)
    return;
  tokenizerWarningSent = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn("[magic-context] ai-tokenizer is unavailable; using approximate character-based token counts for this process. Token budgets, persisted per-message counts, and protected-tail/compartment boundaries may be less accurate until restart:", reason);
}
function getTokenizer() {
  if (tokenizer || tokenizerLoadAttempted)
    return tokenizer;
  tokenizerLoadAttempted = true;
  try {
    tokenizer = loadTokenizer();
  } catch (error) {
    warnTokenizerFallback(error);
  }
  return tokenizer;
}
function estimateTokensHeuristically(text) {
  return Math.ceil(text.length / 3.5);
}
function estimateTokens(text) {
  if (!text)
    return 0;
  const activeTokenizer = getTokenizer();
  if (!activeTokenizer)
    return estimateTokensHeuristically(text);
  try {
    return activeTokenizer.encode(text, "all").length;
  } catch (error) {
    tokenizer = undefined;
    tokenizerLoadAttempted = true;
    warnTokenizerFallback(error);
    return estimateTokensHeuristically(text);
  }
}
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function compactRole(role) {
  if (role === "assistant")
    return "A";
  if (role === "user")
    return "U";
  return role.slice(0, 1).toUpperCase() || "M";
}
function formatBlock(block) {
  const range = block.startOrdinal === block.endOrdinal ? `[${block.startOrdinal}]` : `[${block.startOrdinal}-${block.endOrdinal}]`;
  const commitSuffix = block.commitHashes.length > 0 ? ` commits: ${block.commitHashes.join(", ")}` : "";
  return `${range} ${block.role}:${commitSuffix} ${block.parts.join(" / ")}`;
}
function extractCommitHashes(text) {
  const hashes = [];
  const seen = new Set;
  for (const match of text.matchAll(createCommitHashExtractPattern())) {
    const hash = match[1]?.toLowerCase();
    if (!hash || seen.has(hash))
      continue;
    seen.add(hash);
    hashes.push(hash);
    if (hashes.length >= MAX_COMMITS_PER_BLOCK)
      break;
  }
  return hashes;
}
function compactTextForSummary(text, role) {
  const commitHashes = role === "assistant" ? extractCommitHashes(text) : [];
  if (commitHashes.length === 0 || !COMMIT_VERB_PATTERN.test(text)) {
    return { text, commitHashes };
  }
  const withoutHashes = text.replace(createCommitHashExtractPattern(), "").replace(/\(\s*\)/g, "").replace(/\s+,/g, ",").replace(/,\s*,+/g, ", ").replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
  return {
    text: withoutHashes.length > 0 ? withoutHashes : text,
    commitHashes
  };
}
function mergeCommitHashes(existing, next) {
  if (next.length === 0)
    return existing;
  const merged = [...existing];
  for (const hash of next) {
    if (merged.includes(hash))
      continue;
    merged.push(hash);
    if (merged.length >= MAX_COMMITS_PER_BLOCK)
      break;
  }
  return merged;
}

// ../plugin/src/shared/stable-json.ts
function stableStringify(value, seen = new WeakSet) {
  if (value === undefined)
    return "undefined";
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? String(value);
  if (seen.has(value))
    return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([a], [b]) => {
    if (a < b)
      return -1;
    if (a > b)
      return 1;
    return 0;
  });
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child, seen)}`).join(",")}}`;
}

// ../plugin/src/features/magic-context/tool-definition-tokens.ts
var measurements = new Map;
var fingerprints = new Map;

// ../plugin/src/features/magic-context/tool-owner-backfill.ts
var LEASE_DURATION_MS = 5 * 60 * 1000;
var LEASE_RENEWAL_MS = 60 * 1000;

// ../plugin/src/features/magic-context/storage-db.ts
var databases = new Map;
var pendingAsyncOpens = new Map;
var persistenceByDatabase = new WeakMap;
var persistenceErrorByDatabase = new WeakMap;
var pathByDatabase = new WeakMap;
var LATEST_SUPPORTED_VERSION = 77;
var PERMISSIONS_ENFORCEABLE = process.platform !== "win32";
function getPersistedSchemaVersion(db) {
  const hasMigrationsTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasMigrationsTable) {
    return 0;
  }
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version < ?").get(FORK_MIGRATION_VERSION_FLOOR);
  return row?.version ?? 0;
}
var RPC_DISCOVERY_PARSE_GRACE_MS = 10 * 60 * 1000;

export { setHarness, getHarness, V2_MEMORY_CATEGORIES, PROMOTABLE_CATEGORIES, getMemoryCategoryOrder, CATEGORY_DEFAULT_TTL, Database, getDataDir, getMagicContextStorageDir, log, sessionLog, shouldEnforcePrivateStoragePermissions, OMO_INTERNAL_INITIATOR_MARKER, removeSystemReminders, hasMeaningfulUserText, extractTexts, extractToolCallSummaries, estimateTokens, normalizeText, compactRole, formatBlock, compactTextForSummary, mergeCommitHashes, isUserHomeDirectory, resolveProjectIdentityForSession, normalizeStoredProjectPath, storedPathBelongsToIdentity, closeQuietly, stableStringify, parseCompartmentOutput, resolveWorkspaceShareCategories, resolveWorkspaceIdentitySet, expandWorkspaceIdentitySetWithAliases, resolveStoredPathWorkspaceIdentity, sourceNameForMemory, computeWorkspaceEpochFingerprint, getErrorMessage, describeError, LATEST_SUPPORTED_VERSION, getPersistedSchemaVersion };
