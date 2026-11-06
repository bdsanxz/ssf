// F-06 tests: multi-skill workspace loading.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillManifestFile, loadWorkspaceSkills } from "../src/workspace.js";

function manifest(id: string): string {
  return [
    "skill:",
    `  id: ${id}`,
    "  version: 1.0.0",
    `  description: Skill ${id}. Use when testing.`,
    "",
  ].join("\n");
}

function makeWorkspace(entries: Record<string, string | null>): string {
  const root = mkdtempSync(join(tmpdir(), "ssf-ws-"));
  for (const [dir, body] of Object.entries(entries)) {
    const full = join(root, dir);
    mkdirSync(full, { recursive: true });
    if (body !== null) {
      writeFileSync(join(full, "skill.manifest"), body);
    }
  }
  return root;
}

describe("loadSkillManifestFile", () => {
  test("parses one manifest from disk", () => {
    const root = makeWorkspace({ "skills/a": manifest("skill-a") });
    const loaded = loadSkillManifestFile(join(root, "skills/a"));
    expect(loaded.skill.id).toBe("skill-a");
  });
});

describe("loadWorkspaceSkills", () => {
  test("loads every listed skill independently", () => {
    const root = makeWorkspace({ "skills/a": manifest("skill-a"), "skills/b": manifest("skill-b") });
    const result = loadWorkspaceSkills(root, ["skills/a", "skills/b"]);
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => s.manifest.skill.id).sort()).toEqual(["skill-a", "skill-b"]);
    expect(result.skills.map((s) => s.dir).sort()).toEqual(["skills/a", "skills/b"]);
  });

  test("keeps working skills when one manifest is missing or invalid", () => {
    const root = makeWorkspace({
      "skills/good": manifest("skill-good"),
      "skills/empty": null,
      "skills/broken": "skill:\n  id: Bad_Name!\n  version: 1.0.0\n  description: x\n",
    });
    const result = loadWorkspaceSkills(root, ["skills/good", "skills/empty", "skills/broken", "skills/gone"]);
    expect(result.skills.map((s) => s.manifest.skill.id)).toEqual(["skill-good"]);
    expect(result.errors.length).toBe(3);
  });

  test("rejects duplicate skill ids", () => {
    const root = makeWorkspace({ "skills/a": manifest("skill-a"), "skills/b": manifest("skill-a") });
    const result = loadWorkspaceSkills(root, ["skills/a", "skills/b"]);
    expect(result.skills.length).toBe(1);
    expect(result.errors.some((e) => e.includes('Duplicate skill id "skill-a"'))).toBe(true);
  });
});
