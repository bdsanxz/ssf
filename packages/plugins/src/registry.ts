// Built-in plugin registry (F-67): name-to-implementation resolution.
// Installed runtimes embed plugin NAMES in their metadata; installed.ts maps
// each name back to one of these builtins. Unknown names fail the install,
// and the caller-token provider is always constructed per call by the
// runtime core (the token never lives in a shared registry).

import type { SsfPlugin } from "@ssf/plugin-api";
import {
  licenseSourceEnv,
  licenseSourceFile,
  keyProviderLease,
  LICENSE_SOURCE_ENV_PLUGIN,
  LICENSE_SOURCE_FILE_PLUGIN,
  KEY_PROVIDER_TOKEN_PLUGIN,
  KEY_PROVIDER_LEASE_PLUGIN,
} from "./providers.js";
import { codecDefaultPlugin, CODEC_DEFAULT_PLUGIN as CODEC_NAME } from "./codec.js";

export {
  LICENSE_SOURCE_ENV_PLUGIN,
  LICENSE_SOURCE_FILE_PLUGIN,
  KEY_PROVIDER_TOKEN_PLUGIN,
  KEY_PROVIDER_LEASE_PLUGIN,
} from "./providers.js";
export { CODEC_DEFAULT_PLUGIN } from "./codec.js";

const STATIC_BUILTINS: Record<string, SsfPlugin> = {
  [LICENSE_SOURCE_ENV_PLUGIN]: licenseSourceEnv,
  [LICENSE_SOURCE_FILE_PLUGIN]: licenseSourceFile,
  [KEY_PROVIDER_LEASE_PLUGIN]: keyProviderLease,
  [CODEC_NAME]: codecDefaultPlugin,
};

/** Default runtime policy: env source first, then the config file. */
export function defaultRuntimePluginNames(): string[] {
  return [LICENSE_SOURCE_ENV_PLUGIN, LICENSE_SOURCE_FILE_PLUGIN];
}

/** Default build policy: the framework tier-1 codec. */
export function defaultBuildPlugins(): SsfPlugin[] {
  return [codecDefaultPlugin];
}

/** Resolve embedded plugin names to builtin implementations. */
export function resolveEmbeddedPlugins(names: string[]): SsfPlugin[] {
  return names.map((name) => {
    if (name === KEY_PROVIDER_TOKEN_PLUGIN) {
      throw new Error(
        'plugin "key-provider-token" is constructed per call by the runtime core and must not be embedded by name',
      );
    }
    const plugin = STATIC_BUILTINS[name];
    if (!plugin) {
      throw new Error(`unknown embedded plugin "${name}": only builtin names resolve inside an installed runtime`);
    }
    return plugin;
  });
}
