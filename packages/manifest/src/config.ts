// Basic validation for ssf.config.ts values.
// F-05: config example from the proposal must load successfully.

import {
  MAX_LINES_PER_FILE,
  type SsfConfig,
  type ValidationResult,
} from "./types.js";

export function validateSsfConfig(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null) {
    return { ok: false, errors: ["Config must be an object."] };
  }
  const c = input as Partial<SsfConfig>;

  if (!c.workspace || typeof c.workspace.publisher !== "string" || c.workspace.publisher.length === 0) {
    errors.push("workspace.publisher must be a non-empty string.");
  }
  if (c.workspace && c.workspace.defaultMode !== "offline" && c.workspace.defaultMode !== "online") {
    errors.push("workspace.defaultMode must be offline or online.");
  }
  if (!c.license || typeof c.license.env !== "string" || c.license.env.length === 0) {
    errors.push("license.env must be a non-empty string.");
  }
  if (!c.license || typeof c.license.configFile !== "string" || c.license.configFile.length === 0) {
    errors.push("license.configFile must be a non-empty string.");
  }
  if (!c.keys || typeof c.keys.dir !== "string" || c.keys.dir.length === 0) {
    errors.push("keys.dir must be a non-empty string.");
  }
  for (const k of ["licenseKid", "artifactKid", "rootKid"] as const) {
    if (!c.keys || typeof c.keys[k] !== "string" || c.keys[k].length === 0) {
      errors.push(`keys.${k} must be a non-empty string.`);
    }
  }
  if (c.keys && c.keys.leaseKid !== undefined && (typeof c.keys.leaseKid !== "string" || c.keys.leaseKid.length === 0)) {
    errors.push("keys.leaseKid must be a non-empty string when set.");
  }
  if (!c.limits || typeof c.limits.defaultMaxLines !== "number" || c.limits.defaultMaxLines < 1) {
    errors.push("limits.defaultMaxLines must be a positive number.");
  } else if (c.limits.defaultMaxLines > MAX_LINES_PER_FILE) {
    errors.push(`limits.defaultMaxLines must not exceed ${MAX_LINES_PER_FILE}.`);
  }
  if (!c.limits || typeof c.limits.defaultMaxChars !== "number" || c.limits.defaultMaxChars < 1) {
    errors.push("limits.defaultMaxChars must be a positive number.");
  }
  if (!Array.isArray(c.skills)) {
    errors.push("skills must be an array of skill directory paths.");
  }
  if (!Array.isArray(c.plugins)) {
    errors.push("plugins must be an array.");
  }

  return { ok: errors.length === 0, errors };
}
