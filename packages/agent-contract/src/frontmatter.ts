// F-27: generated SKILL.md frontmatter (Agent Skills).
// The frontmatter is fully generated from the skill manifest and the
// workspace config; any hand edits are overwritten at build time. Only
// specification fields appear at the top level; custom data lives in
// metadata with framework keys prefixed ssf-.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { isValidName, MAX_DESCRIPTION_LENGTH } from "@ssf/manifest";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

export const SSF_FORMAT = "1";
export const MAX_COMPATIBILITY_LENGTH = 500;

const TOP_LEVEL_FIELDS = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
]);

export interface FrontmatterData {
  name: string;
  description: string;
  license?: string;
  compatibility: string;
  metadata: Record<string, string>;
  allowedTools?: string;
}

/** Build the compatibility line: Node.js, license env var, network needs. */
export function buildCompatibility(
  mode: "offline" | "online",
  licenseEnv: string,
): string {
  const network =
    mode === "online"
      ? "Online mode needs network access for license verification."
      : "Offline mode needs no network.";
  return `Requires Node.js and a license key (variable ${licenseEnv}). ${network}`;
}

/** Generate frontmatter data from a manifest and a workspace config. */
export function generateFrontmatterData(
  manifest: SkillManifest,
  config: Pick<SsfConfig, "workspace" | "license" | "agent">,
): FrontmatterData {
  const mode = manifest.license?.mode ?? config.workspace.defaultMode;
  const data: FrontmatterData = {
    name: manifest.skill.id,
    description: manifest.skill.description,
    compatibility: buildCompatibility(mode, config.license.env),
    metadata: {
      "ssf-publisher": config.workspace.publisher,
      "ssf-version": manifest.skill.version,
      "ssf-format": SSF_FORMAT,
      ...manifest.skill.metadata,
    },
  };
  if (manifest.skill.license) {
    data.license = manifest.skill.license;
  }
  if (config.agent.allowedTools) {
    data.allowedTools = config.agent.allowedTools;
  }
  return data;
}

/** Serialize frontmatter data to a --- fenced YAML block with safe quoting. */
export function renderFrontmatter(data: FrontmatterData): string {
  const document: Record<string, unknown> = {
    name: data.name,
    description: data.description,
  };
  if (data.license !== undefined) {
    document["license"] = data.license;
  }
  document["compatibility"] = data.compatibility;
  document["metadata"] = data.metadata;
  if (data.allowedTools !== undefined) {
    document["allowed-tools"] = data.allowedTools;
  }
  return `---\n${stringifyYaml(document)}---\n`;
}

/** Split an author SKILL.md into optional frontmatter and the body. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { frontmatter: null, body: text };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { frontmatter: null, body: text };
  }
  const close = text.indexOf("\n", end + 4);
  if (close === -1) {
    return { frontmatter: text, body: "" };
  }
  return { frontmatter: text.slice(0, close), body: text.slice(close + 1) };
}

/** Remove --- fences so fenced and bare YAML both validate. */
export function unwrapFrontmatterFence(text: string): string {
  const { frontmatter } = splitFrontmatter(text);
  if (frontmatter === null) {
    return text;
  }
  const lines = frontmatter.split("\n");
  const inner = lines[0]?.trim() === "---" ? lines.slice(1) : lines;
  if (inner.length > 0 && inner[inner.length - 1]?.trim() === "---") {
    inner.pop();
  }
  return inner.join("\n");
}

/** Validate frontmatter text against the Agent Skills rules used by ssf. */
export function validateFrontmatter(text: string): string[] {
  const errors: string[] = [];
  let data: Record<string, unknown>;
  try {
    data = parseYaml(unwrapFrontmatterFence(text)) as Record<string, unknown>;
  } catch {
    return ["Frontmatter is not valid YAML."];
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return ["Frontmatter must be a YAML mapping."];
  }
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      errors.push(`Unknown top-level frontmatter field: ${key}`);
    }
  }
  if (typeof data["name"] !== "string" || !isValidName(data["name"])) {
    errors.push("Frontmatter name must match the skill id rules.");
  }
  if (typeof data["description"] !== "string" || data["description"].length === 0) {
    errors.push("Frontmatter description must be a non-empty string.");
  } else if (data["description"].length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`Frontmatter description must not exceed ${MAX_DESCRIPTION_LENGTH} chars.`);
  }
  if (typeof data["compatibility"] !== "string" || data["compatibility"].length === 0) {
    errors.push("Frontmatter compatibility must be a non-empty string.");
  } else if (data["compatibility"].length > MAX_COMPATIBILITY_LENGTH) {
    errors.push(`Frontmatter compatibility must not exceed ${MAX_COMPATIBILITY_LENGTH} chars.`);
  }
  if (data["metadata"] === undefined || typeof data["metadata"] !== "object" || data["metadata"] === null) {
    errors.push("Frontmatter metadata must be a mapping.");
  } else {
    for (const [key, value] of Object.entries(data["metadata"] as Record<string, unknown>)) {
      if (typeof value !== "string") {
        errors.push(`Frontmatter metadata value must be a string: ${key}`);
      }
    }
  }
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string") {
    errors.push("Frontmatter allowed-tools must be a string when present.");
  }
  return errors;
}
