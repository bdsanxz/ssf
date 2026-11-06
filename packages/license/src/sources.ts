// F-34: license key sources (env var first, then user config file).
// Many harnesses do not forward env vars to agent processes, so a config
// file is the fallback. Other sources (keychains, secret managers) plug in
// later through the loadLicense hook; the default order here stays fixed.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LicenseKeySource = "env" | "file";

export interface LoadedLicenseKey {
  token: string;
  source: LicenseKeySource;
}

export interface LicenseSourceOptions {
  envVar: string;
  /** Config file path relative to the user config dir. */
  configFile: string;
  /** Overrides the user config dir (tests and portable setups). */
  configDir?: string;
}

/** Default user config dir: XDG_CONFIG_HOME or ~/.config. */
export function defaultConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) {
    return xdg;
  }
  return join(homedir(), ".config");
}

/**
 * Load one publisher license key. Env var wins; the config file is the
 * fallback. Returns null when neither provides a non-empty token.
 */
export function loadLicenseKey(options: LicenseSourceOptions): LoadedLicenseKey | null {
  const fromEnv = (process.env[options.envVar] ?? "").trim();
  if (fromEnv.length > 0) {
    return { token: fromEnv, source: "env" };
  }
  const file = join(options.configDir ?? defaultConfigDir(), options.configFile);
  try {
    if (!statSync(file).isFile()) {
      return null;
    }
    const token = readFileSync(file, "utf8").trim();
    if (token.length === 0) {
      return null;
    }
    return { token, source: "file" };
  } catch {
    return null;
  }
}
