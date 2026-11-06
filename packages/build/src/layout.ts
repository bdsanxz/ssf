// F-30: distribution layout writer for dist/skills/<id>/.
// One skill package holds SKILL.md, the public skill.manifest, public
// companion files in place, and scripts/runtime.js plus scripts/runtime.bin.
// The folder name always equals the skill id, so every package installs
// standalone. Distribution repos stay separate from private sources.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUNTIME_JS_PATH = "scripts/runtime.js";
export const RUNTIME_BIN_PATH = "scripts/runtime.bin";
export const SKILL_MD_PATH = "SKILL.md";
export const MANIFEST_PATH = "skill.manifest";

/** Package files as skill-relative path to bytes. */
export type PackageFiles = Map<string, Buffer>;

/** Folder name for a skill id inside dist/skills. */
export function packageDirName(skillId: string): string {
  return skillId;
}

/** Write every package file under dist/skills/<id>/. */
export function writeSkillPackage(distSkillsDir: string, skillId: string, files: PackageFiles): string {
  const outDir = join(distSkillsDir, packageDirName(skillId));
  for (const [relative, content] of files) {
    if (relative.startsWith("/") || relative.includes("..")) {
      throw new Error(`Refusing to write outside the package: ${relative}`);
    }
    const full = join(outDir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return outDir;
}
