// F-74: source and dist validation through the CLI modules.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateDistPackages, validatePluginSpecs, warnPluginSpecConventions, validateWorkspaceSkills } from "../src/validate.js";

const MANIFEST = (body: string): string =>
  [
    "skill:",
    "  id: demo",
    "  version: 1.0.0",
    "  description: Demo skill for validation. Use when testing validate.",
    "  license: Proprietary",
    "",
    "license:",
    "  mode: offline",
    "",
    body,
    "",
  ].join("\n");

function sourceFixture(manifestBody: string, skillMd: string, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "ssf-val-"));
  const skill = join(root, "skills", "demo");
  mkdirSync(skill, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(skill, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(skill, "skill.manifest"), MANIFEST(manifestBody));
  writeFileSync(join(skill, "SKILL.md"), skillMd);
  return root;
}

describe("validateWorkspaceSkills", () => {
  test("clean skill passes with no errors or warnings", () => {
    const root = sourceFixture(
      "companion_files:\n  - path: references/a.md\n    protection: none\n    description: Doc for picking. Use when testing.\nscripts:\n  - id: run-it\n    entry: src/run.ts\n    description: Runs\n    usage: <file>\n",
      "# Demo\n\nUse search before read.\n",
      { "references/a.md": "hello\n", "src/run.ts": "console.log(1);\n" },
    );
    const report = validateWorkspaceSkills(root, ["skills/demo"]);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test("script without usage is an error; protected file without description warns", () => {
    const root = sourceFixture(
      "companion_files:\n  - path: secrets/s.md\n    protection: encrypted\nscripts:\n  - id: run-it\n    entry: src/run.ts\n    description: Runs\n",
      "# Demo\n",
      { "secrets/s.md": "x\n", "src/run.ts": "console.log(1);\n" },
    );
    const report = validateWorkspaceSkills(root, ["skills/demo"]);
    expect(report.errors.some((entry) => entry.includes("run-it") && entry.includes("usage"))).toBe(true);
    expect(report.warnings.some((entry) => entry.includes("s.md") && entry.includes("description"))).toBe(true);
  });

  test("unknown skill and missing manifest are errors", () => {
    const root = sourceFixture("", "# Demo\n", {});
    expect(validateWorkspaceSkills(root, ["skills/demo"], "nope").errors).toHaveLength(1);
    const empty = mkdtempSync(join(tmpdir(), "ssf-val-empty-"));
    mkdirSync(join(empty, "skills", "demo"), { recursive: true });
    expect(validateWorkspaceSkills(empty, ["skills/demo"]).errors.some((entry) => entry.includes("skill.manifest"))).toBe(true);
  });
});

describe("validatePluginSpecs", () => {
  test("bare package names outside ssf-plugin-* warn (F-68)", () => {
    expect(warnPluginSpecConventions([])).toEqual([]);
    expect(warnPluginSpecConventions(["./local.mjs", "/abs/path.mjs", "ssf-plugin-toc"])).toEqual([]);
    const warnings = warnPluginSpecConventions(["some-package", "SSF-PLUGIN-UPPER"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("ssf-plugin-*");
  });

  test("bad plugin shapes and missing modules are errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "ssf-valplug-"));
    writeFileSync(join(root, "ok.mjs"), "export default { name: 'ok', apiVersion: 1 };");
    writeFileSync(join(root, "bad.mjs"), "export default { name: 'Bad', apiVersion: 1 };");
    expect(await validatePluginSpecs(root, ["./ok.mjs"])).toEqual([]);
    expect(await validatePluginSpecs(root, [])).toEqual([]);
    const bad = await validatePluginSpecs(root, ["./bad.mjs"]);
    expect(bad).toHaveLength(1);
    expect(bad[0]).toContain("plugins:");
    expect(await validatePluginSpecs(root, ["./missing.mjs"])).toHaveLength(1);
  });
});

describe("validateDistPackages", () => {
  test("missing dist fails with a build-first hint", () => {
    const root = mkdtempSync(join(tmpdir(), "ssf-val-nodist-"));
    const report = validateDistPackages(root, []);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("ssf build");
  });
});
