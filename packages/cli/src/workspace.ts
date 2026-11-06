// Minimal workspace discovery for Sprint 1 (F-04).
// Finds ssf.config.ts by walking up and lists declared skill directories.

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const CONFIG_FILENAMES = ["ssf.config.ts", "ssf.config.js", "ssf.config.mjs"];

export function findWorkspaceRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      try {
        if (statSync(join(dir, name)).isFile()) return dir;
      } catch {
        // Keep walking up.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function listSkillDirs(workspaceDir: string, skills: string[]): string[] {
  return skills.map((s) => join(workspaceDir, s));
}
