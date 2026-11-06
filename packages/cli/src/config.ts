// defineConfig helper for ssf.config.ts (F-05).
// Re-exports the workspace config type from @ssf/manifest.

import type { SsfConfig } from "@ssf/manifest";

export type { SsfConfig };

export function defineConfig(config: SsfConfig): SsfConfig {
  return config;
}
