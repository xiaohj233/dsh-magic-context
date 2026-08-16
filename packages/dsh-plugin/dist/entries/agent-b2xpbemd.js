// ../plugin/src/config/migrate-config-location.ts
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
var CONFIG_FILE_BASENAME = "magic-context";
function homeDir() {
  if (process.platform === "win32") {
    return process.env.USERPROFILE || process.env.HOME || homedir();
  }
  return process.env.HOME || homedir();
}
function configHome() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg))
    return xdg;
  return join(homeDir(), ".config");
}
function cortexKitUserConfigBasePath() {
  return join(configHome(), "cortexkit", CONFIG_FILE_BASENAME);
}
function cortexKitProjectConfigBasePath(directory) {
  return join(directory, ".cortexkit", CONFIG_FILE_BASENAME);
}
function resolveCortexKitUserConfigPath() {
  return `${cortexKitUserConfigBasePath()}.jsonc`;
}
function legacySourcesForBase(basePath, label) {
  return [
    { path: `${basePath}.jsonc`, label: `${label} magic-context.jsonc` },
    { path: `${basePath}.json`, label: `${label} magic-context.json` }
  ];
}
function userScopeConfigPaths() {
  return new Set([
    `${cortexKitUserConfigBasePath()}.jsonc`,
    `${cortexKitUserConfigBasePath()}.json`,
    join(configHome(), "opencode", `${CONFIG_FILE_BASENAME}.jsonc`),
    join(configHome(), "opencode", `${CONFIG_FILE_BASENAME}.json`),
    join(homeDir(), ".pi", "agent", `${CONFIG_FILE_BASENAME}.jsonc`),
    join(homeDir(), ".pi", "agent", `${CONFIG_FILE_BASENAME}.json`)
  ]);
}
function resolveLegacyConfigSources(directory) {
  const userPaths = userScopeConfigPaths();
  return {
    user: [
      ...legacySourcesForBase(join(configHome(), "opencode", CONFIG_FILE_BASENAME), "OpenCode user"),
      ...legacySourcesForBase(join(homeDir(), ".pi", "agent", CONFIG_FILE_BASENAME), "Pi user")
    ],
    project: [
      ...legacySourcesForBase(join(directory, CONFIG_FILE_BASENAME), "project root"),
      ...legacySourcesForBase(join(directory, ".opencode", CONFIG_FILE_BASENAME), "OpenCode project"),
      ...legacySourcesForBase(join(directory, ".pi", CONFIG_FILE_BASENAME), "Pi project")
    ].filter((source) => !userPaths.has(source.path))
  };
}
function resolveLegacyConfigSourcesForHarness(directory, harness) {
  if (harness === "pi") {
    return {
      user: legacySourcesForBase(join(homeDir(), ".pi", "agent", CONFIG_FILE_BASENAME), "Pi user"),
      project: legacySourcesForBase(join(directory, ".pi", CONFIG_FILE_BASENAME), "Pi project")
    };
  }
  return {
    user: legacySourcesForBase(join(configHome(), "opencode", CONFIG_FILE_BASENAME), "OpenCode user"),
    project: [
      ...legacySourcesForBase(join(directory, CONFIG_FILE_BASENAME), "project root"),
      ...legacySourcesForBase(join(directory, ".opencode", CONFIG_FILE_BASENAME), "OpenCode project")
    ]
  };
}

export { cortexKitUserConfigBasePath, cortexKitProjectConfigBasePath, resolveCortexKitUserConfigPath, resolveLegacyConfigSources, resolveLegacyConfigSourcesForHarness };
