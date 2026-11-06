// Basic validation for skill.manifest values.
// F-08: the example manifest from the proposal must parse and validate.

import { parse as parseYaml } from "yaml";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_LINES_PER_FILE,
  MAX_NAME_LENGTH,
  NAME_PATTERN,
  type SkillManifest,
  type ValidationResult,
} from "./types.js";

export function isValidName(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length < 1 || value.length > MAX_NAME_LENGTH) return false;
  if (value.startsWith("-") || value.endsWith("-")) return false;
  if (value.includes("--")) return false;
  return NAME_PATTERN.test(value);
}

/**
 * Convert an OS path to a logical skill path: backslashes become slashes, a
 * Windows drive prefix and leading ./ segments are stripped. The result must
 * still pass isValidLogicalPath before use.
 */
export function toLogicalPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^[A-Za-z]:\//, "").replace(/^(?:\.\/)+/, "");
}

export function isValidLogicalPath(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  const parts = value.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return false;
  return true;
}

export function parseSkillManifestText(text: string): SkillManifest {
  const data = parseYaml(text);
  return data as SkillManifest;
}

export function validateSkillManifest(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["Manifest must be an object."] };
  }
  const m = input as Partial<SkillManifest>;

  if (!m.skill || typeof m.skill.id !== "string" || !isValidName(m.skill.id)) {
    errors.push("skill.id must match ^[a-z0-9]+(-[a-z0-9]+)*$, 1-64 chars, no leading/trailing/consecutive hyphens.");
  }
  if (!m.skill || typeof m.skill.version !== "string" || m.skill.version.length === 0) {
    errors.push("skill.version must be a non-empty string.");
  }
  if (!m.skill || typeof m.skill.description !== "string" || m.skill.description.length === 0) {
    errors.push("skill.description must be a non-empty string.");
  } else if (m.skill.description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`skill.description must not exceed ${MAX_DESCRIPTION_LENGTH} chars.`);
  }
  if (m.skill?.metadata && typeof m.skill.metadata !== "object") {
    errors.push("skill.metadata must be a string-to-string map when present.");
  }

  if (m.license && m.license.mode !== undefined && m.license.mode !== "offline" && m.license.mode !== "online") {
    errors.push("license.mode must be offline or online when present.");
  }

  for (const entry of m.shared ?? []) {
    if (!isValidLogicalPath(entry.path)) {
      errors.push(`shared path is invalid (must use /, no .. or absolute): ${entry.path}`);
    }
  }

  for (const file of m.companion_files ?? []) {
    if (!isValidLogicalPath(file.path)) {
      errors.push(`companion_files path is invalid (must use /, no .. or absolute): ${file.path}`);
    }
    const protection = file.protection ?? "none";
    if (protection !== "none" && protection !== "obfuscated" && protection !== "encrypted") {
      errors.push(`companion_files protection must be none, obfuscated, or encrypted: ${file.path}`);
    }
    if (file.max_lines !== undefined && (typeof file.max_lines !== "number" || file.max_lines < 1)) {
      errors.push(`companion_files max_lines must be positive: ${file.path}`);
    } else if (file.max_lines !== undefined && file.max_lines > MAX_LINES_PER_FILE) {
      errors.push(`companion_files max_lines must not exceed ${MAX_LINES_PER_FILE}: ${file.path}`);
    }
    if (file.description !== undefined && typeof file.description !== "string") {
      errors.push(`companion_files description must be a string: ${file.path}`);
    }
  }

  for (const script of m.scripts ?? []) {
    if (!isValidName(script.id)) {
      errors.push(`scripts id is invalid (same rules as skill name): ${script.id}`);
    }
    if (typeof script.entry !== "string" || script.entry.length === 0) {
      errors.push(`scripts entry must be a non-empty string: ${script.id}`);
    }
    if (typeof script.description !== "string" || script.description.length === 0) {
      errors.push(`scripts description is required: ${script.id}`);
    }
    if (typeof script.usage !== "string" || script.usage.length === 0) {
      errors.push(`scripts usage is required: ${script.id}`);
    }
  }

  return { ok: errors.length === 0, errors };
}
