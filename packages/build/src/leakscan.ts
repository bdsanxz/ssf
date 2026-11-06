// F-32: final build leak scan.
// The scan runs over the finished package and fails the build on any
// violation: protected plaintext or script sources in text files, shipped
// source maps, dirty public manifests, bad frontmatter, private keys, a
// missing or stale ssf block, shared/ paths, test kids in the container,
// invalid plugin shape/apiVersion, failed plugin contract tests, or a
// release record that does not cover the shipped hash. Publisher-key
// refusal and release immutability stay pipeline-stage gates, proven by
// dedicated tests alongside determinism and diversification.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { decodeContainer } from "@ssf/crypto";
import { isTestKid } from "@ssf/crypto";
import {
  generateSsfBlock,
  SSF_BEGIN,
  SSF_END,
  splitFrontmatter,
  unwrapFrontmatterFence,
  validateFrontmatter,
} from "@ssf/agent-contract";
import { parse as parseYaml } from "yaml";
import { isValidLogicalPath, validateScriptEntry, type SkillManifest } from "@ssf/manifest";
import { validatePlugin, type SsfPlugin } from "@ssf/plugin-api";
import { readReleases } from "./releases.js";

export interface LeakScanContext {
  pkgDir: string;
  skillId: string;
  manifest: SkillManifest;
  /** Protected file contents and script sources; must appear nowhere as text. */
  secretTexts: string[];
  /** Dev builds carry kid dev by design; only the test-kid check is skipped. */
  dev?: boolean;
  /**
   * F-32b4/F-66: the resolved build plugins plus their aggregated contract
   * results. The final check re-validates shape/apiVersion and requires
   * every contract test to have passed; the pipeline always supplies these
   * (it fails earlier otherwise), direct callers may omit them to skip.
   */
  plugins?: SsfPlugin[];
  contractTests?: Array<{ hook: string; passed: boolean }>;
  /**
   * F-32b5: the releases log plus the hash the pipeline just recorded. The
   * final check requires the log to carry this exact skill@version hash,
   * closing the loop between shipped bits and the release record.
   */
  releasesLog?: string;
  expectedHash?: string;
}

const TEXT_EXTENSIONS = new Set([".js", ".md", ".json", ".txt", ".yaml", ".yml"]);

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function isTextFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return true;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

/** Scan a finished package. Returns violations; empty means clean. */
export function scanPackageForLeaks(ctx: LeakScanContext): string[] {
  const violations: string[] = [];
  const files = walkFiles(ctx.pkgDir);

  const protectedIds = new Set(
    (ctx.manifest.companion_files ?? [])
      .filter((file) => (file.protection ?? "none") !== "none")
      .map((file) => file.path),
  );
  const protectedDescriptions = new Set(
    (ctx.manifest.companion_files ?? [])
      .filter((file) => (file.protection ?? "none") !== "none" && file.description)
      .map((file) => file.description as string),
  );
  const scripts = ctx.manifest.scripts ?? [];

  for (const file of files) {
    const relativePath = relative(ctx.pkgDir, file).replace(/\\/g, "/");
    if (relativePath.endsWith(".map")) {
      violations.push(`Source map shipped in package: ${relativePath}`);
      continue;
    }
    if (relativePath.startsWith("shared/")) {
      violations.push(`Undeclared shared path shipped in package: ${relativePath}`);
    }
    if (!isTextFile(relativePath)) continue;
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(content)) {
      violations.push(`Private key material in package: ${relativePath}`);
    }
    for (const secret of ctx.secretTexts) {
      if (secret.length >= 16 && content.includes(secret)) {
        violations.push(`Protected plaintext leaked into package file: ${relativePath}`);
        break;
      }
    }
  }

  for (const script of scripts) {
    violations.push(...validateScriptEntry(script).map((detail) => `Script check: ${detail}`));
    if (!isValidLogicalPath(script.entry)) {
      violations.push(`Script entry is not a workspace-relative path: ${script.id}`);
    }
  }

  const manifestPath = join(ctx.pkgDir, "skill.manifest");
  try {
    const shipped = parseYaml(readFileSync(manifestPath, "utf8")) as Partial<SkillManifest>;
    for (const file of shipped.companion_files ?? []) {
      if ((file.protection ?? "none") !== "none") {
        violations.push(`Protected file listed in public manifest: ${file.path}`);
      }
      if (protectedIds.has(file.path)) {
        violations.push(`Protected path leaked into public manifest: ${file.path}`);
      }
    }
    if (shipped.scripts !== undefined && (shipped.scripts ?? []).length > 0) {
      violations.push("Public manifest must not contain a scripts section.");
    }
    const shippedText = readFileSync(manifestPath, "utf8");
    for (const description of protectedDescriptions) {
      if (shippedText.includes(description)) {
        violations.push("Protected file description leaked into public manifest.");
        break;
      }
    }
    for (const script of scripts) {
      if (
        shippedText.includes(script.id) ||
        shippedText.includes(script.entry) ||
        shippedText.includes(script.usage)
      ) {
        violations.push(`Script reference leaked into public manifest: ${script.id}`);
        break;
      }
    }
  } catch {
    violations.push("Public skill.manifest is missing or unreadable.");
  }

  const skillMdPath = join(ctx.pkgDir, "SKILL.md");
  let skillMd = "";
  try {
    skillMd = readFileSync(skillMdPath, "utf8");
  } catch {
    violations.push("SKILL.md is missing from the package.");
  }
  if (skillMd) {
    const { frontmatter, body } = splitFrontmatter(skillMd);
    if (frontmatter === null) {
      violations.push("SKILL.md has no generated frontmatter fence.");
    } else {
      violations.push(...validateFrontmatter(frontmatter).map((detail) => `Frontmatter: ${detail}`));
      try {
        const data = parseYaml(unwrapFrontmatterFence(frontmatter)) as { name?: unknown };
        if (data?.name !== ctx.skillId) {
          violations.push(`Frontmatter name must equal the skill id: ${ctx.skillId}`);
        }
      } catch {
        violations.push("Frontmatter is not valid YAML.");
      }
    }
    const begin = body.indexOf(SSF_BEGIN);
    const end = body.indexOf(SSF_END);
    if (begin === -1 || end === -1 || end < begin) {
      violations.push("SKILL.md is missing the generated ssf block.");
    } else {
      const shipped = body.slice(begin + SSF_BEGIN.length, end).trim();
      if (shipped !== generateSsfBlock(ctx.manifest).trim()) {
        violations.push("SKILL.md ssf block is stale or inconsistent with the manifest.");
      }
    }
  }
  if (basename(ctx.pkgDir) !== ctx.skillId) {
    violations.push(`Package folder name must equal the skill id: ${ctx.skillId}`);
  }

  try {
    const container = decodeContainer(readFileSync(join(ctx.pkgDir, "scripts", "runtime.bin")));
    if (isTestKid(container.rootKid) && ctx.dev !== true) {
      violations.push(`Test kid shipped in production container: ${container.rootKid}`);
    }
  } catch {
    violations.push("Container scripts/runtime.bin is missing or corrupt.");
  }

  // F-32b4/F-66 rule 4+5: the final gate re-checks plugin shape/apiVersion
  // and requires every contract test green. resolveBuildPlugins enforces
  // the same gates earlier; this is the checklist copy that ships.
  for (const plugin of ctx.plugins ?? []) {
    for (const problem of validatePlugin(plugin)) {
      violations.push(`Plugin "${plugin.name ?? "unknown"}" is invalid: ${problem}`);
    }
  }
  for (const result of ctx.contractTests ?? []) {
    if (!result.passed) {
      violations.push(`Plugin contract test failed: ${result.hook}`);
    }
  }

  // F-32b5: the shipped bits must match the release record just written.
  if (ctx.releasesLog !== undefined && ctx.expectedHash !== undefined) {
    const recorded = readReleases(ctx.releasesLog).filter(
      (record) => record.skill === ctx.skillId && record.version === ctx.manifest.skill.version,
    );
    if (!recorded.some((record) => record.hash === ctx.expectedHash)) {
      violations.push(`Releases log has no ${ctx.skillId}@${ctx.manifest.skill.version} entry for the shipped hash.`);
    }
  }

  return violations;
}
