// F-10: script declarations referenced by id.
// A script has an id, a bundled source entry, a description, and usage text.
// Description and usage are required because agents cannot read the source to
// learn how to call it. The id is the only handle agents ever see: SKILL.md
// and list output must reference scripts by id, never by file path. Output
// caps and timeouts fall back to the workspace limits when omitted.

import { isValidLogicalPath, isValidName } from "./manifest.js";
import type { ScriptEntry, SkillManifest, SsfConfig } from "./types.js";

export interface ResolvedScriptLimits {
  maxOutputChars: number;
  timeoutSeconds: number;
}

/** Validate one script entry beyond the base schema checks. */
export function validateScriptEntry(script: ScriptEntry): string[] {
  const errors: string[] = [];
  if (!isValidName(script.id)) {
    errors.push(`scripts id is invalid (same rules as skill name): ${script.id}`);
  }
  if (typeof script.entry !== "string" || script.entry.length === 0) {
    errors.push(`scripts entry must be a non-empty string: ${script.id}`);
  } else if (!isValidLogicalPath(script.entry)) {
    errors.push(`scripts entry must be a workspace-relative path (no .. or absolute): ${script.id}`);
  }
  if (typeof script.description !== "string" || script.description.length === 0) {
    errors.push(`scripts description is required: ${script.id}`);
  }
  if (typeof script.usage !== "string" || script.usage.length === 0) {
    errors.push(`scripts usage is required: ${script.id}`);
  }
  if (
    script.max_output_chars !== undefined &&
    (typeof script.max_output_chars !== "number" || script.max_output_chars < 1)
  ) {
    errors.push(`scripts max_output_chars must be positive: ${script.id}`);
  }
  if (
    script.timeout_seconds !== undefined &&
    (typeof script.timeout_seconds !== "number" || script.timeout_seconds < 1)
  ) {
    errors.push(`scripts timeout_seconds must be positive: ${script.id}`);
  }
  return errors;
}

/** Find a script by id. Returns undefined when the id is not registered. */
export function findScriptById(manifest: SkillManifest, id: string): ScriptEntry | undefined {
  return (manifest.scripts ?? []).find((script) => script.id === id);
}

/**
 * Resolve output caps and timeout for one script. Entry values win;
 * workspace defaults are the fallback.
 */
export function effectiveScriptLimits(
  script: ScriptEntry,
  config: Pick<SsfConfig, "limits">,
): ResolvedScriptLimits {
  return {
    maxOutputChars: script.max_output_chars ?? config.limits.defaultScriptOutputChars,
    timeoutSeconds: script.timeout_seconds ?? config.limits.defaultScriptTimeoutSeconds,
  };
}

/**
 * Detect script entry paths leaked into free text (SKILL.md body or similar).
 * Scripts are referenced by id only; a raw entry path in text is a leak.
 * Returns the leaked entry paths found in the text.
 */
export function findScriptPathReferences(text: string, manifest: SkillManifest): string[] {
  const leaked: string[] = [];
  for (const script of manifest.scripts ?? []) {
    if (text.includes(script.entry) && !leaked.includes(script.entry)) {
      leaked.push(script.entry);
    }
  }
  return leaked;
}
