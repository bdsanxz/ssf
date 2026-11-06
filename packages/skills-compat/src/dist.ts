// @ssf/skills-compat - distribution package validation (F-81).
// Checks that a built package in dist/skills/<id>/ is a valid,
// installable Agent Skills skill: spec-compliant frontmatter, folder/name
// agreement, public-only manifest, required runtime files, and resolvable
// relative links. Source-side authoring rules live in @ssf/manifest.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { extractRelativeLinks } from "@ssf/manifest";

export interface DistributionCheck {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

export interface DistributionResult {
  skillId: string;
  errors: DistributionCheck[];
  warnings: DistributionCheck[];
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function parseFrontmatterYaml(text: string): { data: Record<string, unknown>; error?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) {
    return { data: {}, error: "SKILL.md has no frontmatter block" };
  }
  try {
    return { data: (parseYaml(match[1] as string) as Record<string, unknown>) ?? {} };
  } catch (error) {
    return { data: {}, error: `SKILL.md frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export interface DistributionOptions {
  /**
   * Source-side paths that must never be link targets (protected companion
   * files, script entries, script ids). The dist package cannot tell a
   * broken link from a link to an unshipped protected file, so the caller
   * (which owns the source manifest) supplies them; matches fail instead
   * of warning.
   */
  forbiddenTargets?: string[];
}

/** Validate one built skill package directory. */
export function validateDistribution(skillDir: string, options: DistributionOptions = {}): DistributionResult {
  const errors: DistributionCheck[] = [];
  const warnings: DistributionCheck[] = [];
  const fail = (rule: string, message: string): void => {
    errors.push({ rule, severity: "error", message });
  };
  const warn = (rule: string, message: string): void => {
    warnings.push({ rule, severity: "warning", message });
  };
  const skillId = basename(resolve(skillDir));

  const skillMdPath = join(skillDir, "SKILL.md");
  let skillMd = "";
  try {
    if (!statSync(skillMdPath).isFile()) {
      fail("skill-md", "SKILL.md is missing from the skill package.");
    } else {
      skillMd = readFileSync(skillMdPath, "utf8");
    }
  } catch {
    fail("skill-md", "SKILL.md is missing from the skill package.");
  }

  if (skillMd) {
    const { data, error } = parseFrontmatterYaml(skillMd);
    if (error) {
      fail("frontmatter", error);
    } else {
      const name = data["name"];
      if (typeof name !== "string" || !NAME_PATTERN.test(name) || name.length > 64) {
        fail("frontmatter", `Frontmatter name ${JSON.stringify(name)} is invalid: lowercase letters, digits, dashes, 1-64 chars.`);
      } else if (name !== skillId) {
        fail("frontmatter", `Folder "${skillId}" does not match frontmatter name "${name}".`);
      }
      const description = data["description"];
      if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
        fail("frontmatter", "Frontmatter description must be 1-1024 chars and say what the skill does and when to use it.");
      } else if (!/when|use|if|for\b/i.test(description)) {
        warn("frontmatter", "Frontmatter description should say when to use the skill.");
      }
      const compatibility = data["compatibility"];
      if (typeof compatibility !== "string" || compatibility.length > 500) {
        fail("frontmatter", "Frontmatter compatibility must be a string of at most 500 chars.");
      } else if (!/node/i.test(compatibility)) {
        warn("frontmatter", "Frontmatter compatibility should mention Node.js.");
      }
      const metadata = data["metadata"];
      if (!metadata || typeof metadata !== "object") {
        fail("frontmatter", "Frontmatter metadata must list ssf-publisher, ssf-version, and ssf-format.");
      } else {
        const record = metadata as Record<string, unknown>;
        for (const key of ["ssf-publisher", "ssf-version", "ssf-format"]) {
          if (typeof record[key] !== "string") {
            fail("frontmatter", `Frontmatter metadata is missing "${key}".`);
          }
        }
      }
    }
    const skillLines = skillMd.split("\n").length;
    if (skillLines > 500) {
      fail("skill-md-length", `SKILL.md has ${skillLines} lines (max 500 per the Agent Skills spec).`);
    } else if (skillLines > 300) {
      warn("skill-md-length", `SKILL.md has ${skillLines} lines; keep it under 300.`);
    }
  }

  const publicPaths = new Set<string>(["SKILL.md", "skill.manifest"]);
  try {
    const raw = readFileSync(join(skillDir, "skill.manifest"), "utf8");
    const manifest = parseYaml(raw) as { companion_files?: Array<{ path?: unknown; protection?: unknown }>; scripts?: unknown };
    if (manifest.scripts !== undefined) {
      fail("public-manifest", "Package skill.manifest must not list scripts; they live in runtime.bin.");
    }
    for (const file of manifest.companion_files ?? []) {
      if (typeof file.path !== "string") {
        fail("public-manifest", "Package skill.manifest lists a companion file without a path.");
        continue;
      }
      if ((file.protection ?? "none") !== "none") {
        fail("public-manifest", `Package skill.manifest leaks protected file "${file.path}".`);
        continue;
      }
      publicPaths.add(file.path);
    }
  } catch {
    fail("public-manifest", "Package skill.manifest is missing or unparsable.");
  }

  for (const required of ["scripts/runtime.js", "scripts/runtime.bin"]) {
    try {
      if (!statSync(join(skillDir, required)).isFile()) {
        fail("layout", `${required} is missing from the skill package.`);
      }
    } catch {
      fail("layout", `${required} is missing from the skill package.`);
    }
  }
  for (const path of publicPaths) {
    if (path === "SKILL.md" || path === "skill.manifest") {
      continue;
    }
    try {
      if (!statSync(join(skillDir, path)).isFile()) {
        fail("layout", `Public file "${path}" listed in skill.manifest is missing.`);
      }
    } catch {
      fail("layout", `Public file "${path}" listed in skill.manifest is missing.`);
    }
  }

  if (skillMd) {
    const pkgDir = resolve(skillDir);
    const forbidden = new Set((options.forbiddenTargets ?? []).map((path) => path.replace(/^\.\//, "")));
    for (const link of extractRelativeLinks(skillMd)) {
      const normalized = link.replace(/^\.\//, "");
      if (forbidden.has(normalized)) {
        fail("links", `SKILL.md links to "${link}", which is protected or a script; reach it through list/read/run instead of a direct link.`);
        continue;
      }
      const target = resolve(pkgDir, link);
      if (!target.startsWith(`${pkgDir}/`) && target !== pkgDir) {
        fail("links", `SKILL.md links outside the package: "${link}".`);
        continue;
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        // Protected files and scripts are reached through list/read/run.
        warn("links", `SKILL.md links to "${link}", which is not a real file; protected files and scripts are reached through list/read/run.`);
      }
    }
  }

  return { skillId, errors, warnings };
}
