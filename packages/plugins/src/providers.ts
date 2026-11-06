// Built-in SSF plugins (F-67, proposal 15.6): license sources and key
// providers. These are policy, not crypto: they only supply the raw key
// string. The runtime core always verifies the token itself, so error codes
// and the fail-closed flow never depend on a plugin. Contexts carry names
// and paths only, never key material.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { defaultConfigDir } from "@ssf/license";
import type { LicenseRequestContext, SsfPlugin } from "@ssf/plugin-api";

export const LICENSE_SOURCE_ENV_PLUGIN = "license-source-env";
export const LICENSE_SOURCE_FILE_PLUGIN = "license-source-file";
export const KEY_PROVIDER_TOKEN_PLUGIN = "key-provider-token";
export const KEY_PROVIDER_LEASE_PLUGIN = "key-provider-lease";

function readConfigFile(context: LicenseRequestContext): string | null {
  const file = join(context.configDir ?? defaultConfigDir(), context.configFile ?? "license");
  try {
    if (!statSync(file).isFile()) {
      return null;
    }
    const token = readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Default source: the publisher env var (name comes from the context). */
export const licenseSourceEnv: SsfPlugin = {
  name: LICENSE_SOURCE_ENV_PLUGIN,
  apiVersion: 1,
  capabilities: ["env"],
  runtime: {
    loadLicense: async (context: LicenseRequestContext): Promise<string | null> => {
      if (!context.envVar) {
        return null;
      }
      const token = (process.env[context.envVar] ?? "").trim();
      return token.length > 0 ? token : null;
    },
  },
};

/** Default source: the user config file fallback. */
export const licenseSourceFile: SsfPlugin = {
  name: LICENSE_SOURCE_FILE_PLUGIN,
  apiVersion: 1,
  capabilities: ["fs"],
  runtime: {
    loadLicense: async (context: LicenseRequestContext): Promise<string | null> => readConfigFile(context),
  },
};

/**
 * Token provider for an explicitly passed caller token (token-first): the
 * runtime constructs this per call, so the token never flows through a
 * shared plugin context. The provider supplies the key; verification stays
 * in the runtime core.
 */
export function createTokenKeyProvider(token: string): SsfPlugin {
  const trimmed = token.trim();
  return {
    name: KEY_PROVIDER_TOKEN_PLUGIN,
    apiVersion: 1,
    runtime: {
      provideKey: async (): Promise<string | null> => (trimmed.length > 0 ? trimmed : null),
    },
  };
}

/**
 * Online lease provider slot (F-41): leases are issued by the online
 * verification service and resolved by the runtime core (cached lease or
 * service call), not through this hook, so this builtin always yields and
 * the core offline/online paths win. The name, hook, and contract-test
 * slot match proposal 15.6; custom providers may still supply key
 * material from other stores via provideKey.
 */
export const keyProviderLease: SsfPlugin = {
  name: KEY_PROVIDER_LEASE_PLUGIN,
  apiVersion: 1,
  runtime: {
    provideKey: async (): Promise<string | null> => null,
  },
};
