// F-07: shared code declarations.
// A skill must declare every shared/ file it uses. Undeclared shared files
// never enter a package (checked here and enforced again at build scan).
// Protection is chosen per using skill, and skills cannot depend on each
// other: shared paths must live under shared/ and never escape it or point
// at another skill.

import { isValidLogicalPath } from "./manifest.js";
import type { SkillManifest } from "./types.js";

export const SHARED_ROOT = "shared/";

/** True when the path is inside the workspace shared/ tree. */
export function isSharedPath(path: string): boolean {
  return isValidLogicalPath(path) && (path === "shared" || path.startsWith(SHARED_ROOT));
}

/**
 * Validate the shared: section of one skill manifest.
 * Returns error strings; an empty array means the section is usable.
 */
export function validateSharedSection(manifest: SkillManifest): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.shared ?? []) {
    if (!isValidLogicalPath(entry.path)) {
      errors.push(`shared path is invalid (must use /, no .. or absolute): ${entry.path}`);
      continue;
    }
    if (!isSharedPath(entry.path)) {
      errors.push(
        `shared path must live under shared/ and never reference another skill: ${entry.path}`,
      );
      continue;
    }
    if (seen.has(entry.path)) {
      errors.push(`shared path is declared twice: ${entry.path}`);
      continue;
    }
    seen.add(entry.path);
  }
  return errors;
}

/** True when the skill manifest declares the given shared logical path. */
export function isSharedDeclared(manifest: SkillManifest, logicalPath: string): boolean {
  return (manifest.shared ?? []).some((entry) => entry.path === logicalPath);
}
