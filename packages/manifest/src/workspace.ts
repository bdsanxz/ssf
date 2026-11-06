// F-06: multi-skill workspace loading.
// One workspace holds many skills; each skill keeps its own id, version,
// and manifest, and releases independently. The loader reads every skill
// directory listed in the workspace config and reports per-skill results,
// so one broken skill never hides another. Duplicate skill ids are rejected
// because the folder name, frontmatter name, and token scope all key on id.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseSkillManifestText, validateSkillManifest } from "./manifest.js";
import type { SkillManifest } from "./types.js";

export const SKILL_MANIFEST_FILENAME = "skill.manifest";

export interface LoadedSkill {
  /** Skill directory relative to the workspace root, as listed in config. */
  dir: string;
  manifest: SkillManifest;
}

export interface WorkspaceLoadResult {
  skills: LoadedSkill[];
  errors: string[];
}

/** Read and parse one skill.manifest file. Throws on missing files. */
export function loadSkillManifestFile(skillDir: string): SkillManifest {
  const path = join(skillDir, SKILL_MANIFEST_FILENAME);
  return parseSkillManifestText(readFileSync(path, "utf8"));
}

/**
 * Load every skill directory of a workspace. Returns loaded skills plus
 * errors for missing manifests, invalid manifests, and duplicate ids.
 */
export function loadWorkspaceSkills(workspaceDir: string, skillDirs: string[]): WorkspaceLoadResult {
  const skills: LoadedSkill[] = [];
  const errors: string[] = [];
  const seenIds = new Map<string, string>();

  for (const dir of skillDirs) {
    const skillDir = join(workspaceDir, dir);
    let manifest: SkillManifest;
    try {
      if (!statSync(skillDir).isDirectory()) {
        errors.push(`Skill directory is missing: ${dir}`);
        continue;
      }
      manifest = loadSkillManifestFile(skillDir);
    } catch {
      errors.push(`Cannot read ${SKILL_MANIFEST_FILENAME} in skill directory: ${dir}`);
      continue;
    }
    const validation = validateSkillManifest(manifest);
    if (!validation.ok) {
      for (const detail of validation.errors) {
        errors.push(`${dir}: ${detail}`);
      }
      continue;
    }
    const id = manifest.skill.id;
    const firstDir = seenIds.get(id);
    if (firstDir !== undefined) {
      errors.push(`Duplicate skill id "${id}" in ${firstDir} and ${dir}; ids must be unique per workspace.`);
      continue;
    }
    seenIds.set(id, dir);
    skills.push({ dir, manifest });
  }

  return { skills, errors };
}
