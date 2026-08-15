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
function resolveCortexKitUserConfigPath() {
  return `${cortexKitUserConfigBasePath()}.jsonc`;
}

export { resolveCortexKitUserConfigPath };
