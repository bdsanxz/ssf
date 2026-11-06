// F-81: distribution validation against the Agent Skills shape.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDistribution } from "../src/index.js";

function skillDir(files: Record<string, string>): string {
  // The package folder name is the skill id and must match frontmatter.
  const dir = join(tmpdir(), `ssf-dist-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, "demo");
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const FRONTMATTER = `---
name: demo
description: Demo skill for validation. Use when testing install flow.
license: Proprietary
compatibility: Needs Node.js and a license key.
metadata:
  ssf-publisher: acme
  ssf-version: 1.0.0
  ssf-format: "1"
---
`;

const MANIFEST = `skill:
  id: demo
  version: 1.0.0
  description: Demo
companion_files:
  - path: references/guide.md
    protection: none
    description: Guide
`;

function good(): Record<string, string> {
  return {
    "SKILL.md": `${FRONTMATTER}\n# Demo\n`,
    "skill.manifest": MANIFEST,
    "references/guide.md": "Guide.\n",
    "scripts/runtime.js": "loader",
    "scripts/runtime.bin": "binary",
  };
}

describe("validateDistribution", () => {
  test("accepts a well-formed package", () => {
    const result = validateDistribution(skillDir(good()));
    expect(result.skillId).toBeString();
    expect(result.errors).toEqual([]);
  });

  test("folder and name must agree; bad names fail", () => {
    const dir = skillDir({ ...good(), "SKILL.md": good()["SKILL.md"]!.replace("name: demo", "name: other") });
    const result = validateDistribution(dir);
    expect(result.errors.some((entry) => entry.message.includes("does not match"))).toBe(true);
  });

  test("protected entries and scripts in the public manifest fail", () => {
    const leaked = good();
    leaked["skill.manifest"] += "  - path: secrets/x.md\n    protection: encrypted\n    description: X\n";
    expect(validateDistribution(skillDir(leaked)).errors.some((entry) => entry.rule === "public-manifest")).toBe(true);
    const withScripts = good();
    withScripts["skill.manifest"] += "scripts:\n  - id: x\n";
    expect(validateDistribution(skillDir(withScripts)).errors.some((entry) => entry.rule === "public-manifest")).toBe(true);
  });

  test("missing runtime files fail; dangling links warn", () => {
    const files = good();
    delete files["scripts/runtime.bin"];
    files["SKILL.md"] += "\nSee [missing](nope.md).\n";
    const result = validateDistribution(skillDir(files));
    expect(result.errors.some((entry) => entry.rule === "layout")).toBe(true);
    expect(result.warnings.some((entry) => entry.rule === "links")).toBe(true);
  });

  test("links to protected or script targets fail when the source names them", () => {
    const files = good();
    files["SKILL.md"] += "\nSee [secret](secrets/notes.md) and [tool](echo-args).\n";
    const without = validateDistribution(skillDir(files));
    expect(without.errors).toEqual([]);
    expect(without.warnings.some((entry) => entry.rule === "links")).toBe(true);
    const withSource = validateDistribution(skillDir(files), { forbiddenTargets: ["secrets/notes.md", "src/echo.ts", "echo-args"] });
    expect(withSource.errors.filter((entry) => entry.rule === "links")).toHaveLength(2);
  });
});
