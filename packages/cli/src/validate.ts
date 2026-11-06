// F-74: workspace validation (source) and distribution validation (--dist).
// Source mode checks the manifest, shared declarations, limits, script
// metadata, and the F-61 progressive-disclosure rules. Dist mode validates
// built packages with @ssf/skills-compat. Errors fail (exit 1); warnings
// print and pass.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  checkAuthoring,
  parseSkillManifestText,
  validateCompanionEntry,
  validateScriptEntry,
  validateSharedSection,
  validateSkillManifest,
  type AuthoringFile,
  type SkillManifest,
} from "@ssf/manifest";
import { validateDistribution } from "@ssf/skills-compat";
import { loadWorkspacePlugins } from "./plugins.js";

export interface ValidateFlags {
  dist?: boolean;
}

export interface ValidateReport {
  errors: string[];
  warnings: string[];
}

/**
 * Validate configured plugins: every spec must load and pass shape,
 * apiVersion, and hook validation. Failures are errors, not warnings.
 */
export async function validatePluginSpecs(workspaceDir: string, specs: string[]): Promise<string[]> {
  try {
    await loadWorkspacePlugins(workspaceDir, specs);
    return [];
  } catch (error) {
    return [`plugins: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/**
 * Naming-convention warnings for third-party plugins (F-68). Bare package
 * specifiers (resolved from node_modules, not a workspace path) should
 * follow the `ssf-plugin-*` convention so customers can tell framework
 * plugins apart; local paths are exempt. Warnings only, never errors.
 */
export function warnPluginSpecConventions(specs: string[]): string[] {
  const warnings: string[] = [];
  for (const spec of specs) {
    if (spec.startsWith(".") || spec.startsWith("/") || spec.includes("://")) {
      continue;
    }
    if (!/^ssf-plugin-[a-z0-9]+(-[a-z0-9]+)*$/.test(spec)) {
      warnings.push(
        `plugins: package "${spec}" does not follow the ssf-plugin-* naming convention (see docs/plugins.md).`,
      );
    }
  }
  return warnings;
}

function readText(path: string): string | null {
  try {
    if (!statSync(path).isFile()) {
      return null;
    }
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  return text.split("\n").length;
}

/** Validate one skill source directory. */
export function validateSkillSource(workspaceDir: string, skillDir: string): ValidateReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const absolute = join(workspaceDir, skillDir);
  const manifestText = readText(join(absolute, "skill.manifest"));
  if (manifestText === null) {
    return { errors: [`${skillDir}: skill.manifest is missing.`], warnings };
  }
  let manifest: SkillManifest;
  try {
    manifest = parseSkillManifestText(manifestText);
  } catch (error) {
    return { errors: [`${skillDir}: skill.manifest does not parse: ${error instanceof Error ? error.message : String(error)}`], warnings };
  }
  for (const entry of validateSkillManifest(manifest).errors) {
    errors.push(`${skillDir}: ${entry}`);
  }
  for (const entry of validateSharedSection(manifest)) {
    errors.push(`${skillDir}: ${entry}`);
  }
  for (const file of manifest.companion_files ?? []) {
    for (const entry of validateCompanionEntry(file)) {
      errors.push(`${skillDir}: ${entry}`);
    }
  }
  for (const script of manifest.scripts ?? []) {
    for (const entry of validateScriptEntry(script)) {
      errors.push(`${skillDir}: ${entry}`);
    }
  }
  const skillMd = readText(join(absolute, "SKILL.md")) ?? "";
  const files: AuthoringFile[] = [];
  for (const file of manifest.companion_files ?? []) {
    const content = readText(join(absolute, file.path));
    if (content === null) {
      errors.push(`${skillDir}: companion file "${file.path}" is missing.`);
      continue;
    }
    files.push({
      path: file.path,
      lines: countLines(content),
      protection: (file.protection ?? "none") as AuthoringFile["protection"],
      description: file.description,
    });
  }
  const publicPaths = ["SKILL.md", "skill.manifest", ...(manifest.companion_files ?? []).filter((file) => (file.protection ?? "none") === "none").map((file) => file.path)];
  for (const finding of checkAuthoring({
    skillMd,
    files,
    scripts: (manifest.scripts ?? []).map((script) => ({ id: script.id, description: script.description, usage: script.usage, entry: script.entry })),
    publicPaths,
  })) {
    const line = `${skillDir}: ${finding.message}`;
    if (finding.severity === "error") {
      errors.push(line);
    } else {
      warnings.push(line);
    }
  }
  return { errors, warnings };
}

/** Validate every skill listed in the workspace config. */
export function validateWorkspaceSkills(workspaceDir: string, skillDirs: string[], only?: string): ValidateReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const selected = only ? skillDirs.filter((dir) => dir === only || dir.endsWith(`/${only}`)) : skillDirs;
  if (only && selected.length === 0) {
    return { errors: [`Skill "${only}" is not listed in ssf.config.ts skills.`], warnings };
  }
  for (const dir of selected) {
    const report = validateSkillSource(workspaceDir, dir);
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  }
  return { errors, warnings };
}

/**
 * Validate built packages in dist/skills/.
 * Source skill dirs resolve the protected/script link targets that must
 * never appear in author text (F-81): the dist package alone cannot tell a
 * broken link from a link to an unshipped protected file.
 */
export function validateDistPackages(workspaceDir: string, skillDirs: string[], only?: string): ValidateReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const distDir = join(workspaceDir, "dist", "skills");
  let entries: string[];
  try {
    entries = readdirSync(distDir);
  } catch {
    return { errors: [`No built packages: ${distDir} does not exist. Run 'ssf build' first.`], warnings };
  }
  const selected = only ? entries.filter((entry) => entry === only) : entries;
  if (only && selected.length === 0) {
    return { errors: [`No built package "${only}" in dist/skills/.`], warnings };
  }
  if (selected.length === 0) {
    return { errors: ["dist/skills/ has no packages. Run 'ssf build' first."], warnings };
  }
  const forbiddenBySkill = new Map<string, string[]>();
  for (const dir of skillDirs) {
    const text = readText(join(workspaceDir, dir, "skill.manifest"));
    if (text === null) {
      continue;
    }
    let manifest: SkillManifest;
    try {
      manifest = parseSkillManifestText(text);
    } catch {
      continue;
    }
    const forbidden: string[] = [];
    for (const file of manifest.companion_files ?? []) {
      if ((file.protection ?? "none") !== "none") {
        forbidden.push(file.path);
      }
    }
    for (const script of manifest.scripts ?? []) {
      forbidden.push(script.entry, script.id);
    }
    forbiddenBySkill.set(manifest.skill.id, forbidden);
  }
  for (const entry of selected) {
    const result = validateDistribution(join(distDir, entry), { forbiddenTargets: forbiddenBySkill.get(entry) });
    for (const finding of result.errors) {
      errors.push(`${entry}: ${finding.message}`);
    }
    for (const finding of result.warnings) {
      warnings.push(`${entry}: ${finding.message}`);
    }
  }
  return { errors, warnings };
}
