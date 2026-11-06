// F-09: companion file declarations and per-read limits.
// max_lines and max_chars bound ONE read call, not the file length. A file
// entry needs a single-line description so list output stays scannable.
// confidentiality_notice defaults to true for protected files and false for
// public ones; explicit values always win. Missing source files fail the
// build instead of shipping a hollow package.

import { statSync } from "node:fs";
import { join } from "node:path";
import { isValidLogicalPath } from "./manifest.js";
import {
  MAX_LINES_PER_FILE,
  type CompanionFileEntry,
  type Protection,
  type SkillManifest,
  type SsfConfig,
} from "./types.js";

export interface ResolvedCompanionLimits {
  maxLines: number;
  maxChars: number;
  notice: boolean;
}

/** Validate one companion entry beyond the base schema checks. */
export function validateCompanionEntry(file: CompanionFileEntry): string[] {
  const errors: string[] = [];
  if (!isValidLogicalPath(file.path)) {
    errors.push(`companion_files path is invalid (must use /, no .. or absolute): ${file.path}`);
  }
  if (file.description !== undefined) {
    if (typeof file.description !== "string" || file.description.length === 0) {
      errors.push(`companion_files description must be a non-empty string: ${file.path}`);
    } else if (file.description.includes("\n")) {
      errors.push(`companion_files description must be a single line: ${file.path}`);
    }
  }
  if (file.max_chars !== undefined && (typeof file.max_chars !== "number" || file.max_chars < 1)) {
    errors.push(`companion_files max_chars must be positive: ${file.path}`);
  }
  if (
    file.confidentiality_notice !== undefined &&
    typeof file.confidentiality_notice !== "boolean"
  ) {
    errors.push(`companion_files confidentiality_notice must be a boolean: ${file.path}`);
  }
  return errors;
}

/** Resolve the effective notice flag: explicit value wins, else protected default. */
export function effectiveNotice(protection: Protection, explicit?: boolean): boolean {
  if (explicit !== undefined) return explicit;
  return protection !== "none";
}

/**
 * Resolve per-read limits for one companion file. Entry values win; the
 * manifest limits section is next; workspace defaults are the fallback.
 */
export function effectiveCompanionLimits(
  file: CompanionFileEntry,
  manifest: SkillManifest,
  config: Pick<SsfConfig, "limits">,
): ResolvedCompanionLimits {
  const maxLines = file.max_lines ?? manifest.limits?.default_max_lines ?? config.limits.defaultMaxLines;
  const maxChars = file.max_chars ?? manifest.limits?.default_max_chars ?? config.limits.defaultMaxChars;
  return {
    maxLines: Math.min(maxLines, MAX_LINES_PER_FILE),
    maxChars,
    notice: effectiveNotice(file.protection ?? "none", file.confidentiality_notice),
  };
}

/** List manifest companion paths missing from the skill directory. */
export function findMissingCompanionFiles(skillDir: string, manifest: SkillManifest): string[] {
  const missing: string[] = [];
  for (const file of manifest.companion_files ?? []) {
    const full = join(skillDir, file.path);
    try {
      if (!statSync(full).isFile()) {
        missing.push(file.path);
      }
    } catch {
      missing.push(file.path);
    }
  }
  return missing;
}
