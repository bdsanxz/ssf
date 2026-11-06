// F-71/F-72/F-73/F-80: generators and plugin listing.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContractTests, validatePlugin } from "@ssf/plugin-api";
import { listWorkspacePlugins } from "../src/plugins.js";
import { generatePlugin, generateReference, generateScript, generateSkill, newWorkspace } from "../src/scaffold.js";
import { validatePluginSpecs, validateWorkspaceSkills } from "../src/validate.js";

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "ssf-gen-"));
  newWorkspace(root, "acme");
  generateSkill(root, "demo", "acme", "ACME_SSF_LICENSE");
  return root;
}

function skillsOf(root: string): string[] {
  const text = readFileSync(join(root, "ssf.config.ts"), "utf8");
  return [...text.matchAll(/"(skills\/[^"]+)"/g)].map((match) => match[1] as string);
}

describe("generate reference (F-71)", () => {
  test("adds a companion file and a manifest entry that validates", () => {
    const root = workspace();
    const skills = skillsOf(root);
    const { text } = generateReference(root, skills, "demo", "topic");
    expect(text).toContain("references/topic.md");
    expect(existsSync(join(root, "skills", "demo", "references", "topic.md"))).toBe(true);
    const report = validateWorkspaceSkills(root, skills);
    expect(report.errors).toEqual([]);
    expect(() => generateReference(root, skills, "demo", "topic")).toThrow("already exists");
    expect(() => generateReference(root, skills, "demo", "../escape")).toThrow("Invalid companion name");
    expect(() => generateReference(root, skills, "nope", "topic")).toThrow("not listed");
  });
});

describe("generate script (F-72)", () => {
  test("adds a script file and a manifest entry with id, description, and usage", () => {
    const root = workspace();
    const skills = skillsOf(root);
    const { text } = generateScript(root, skills, "demo", "run-it");
    expect(text).toContain("run-it");
    expect(existsSync(join(root, "skills", "demo", "src", "run-it.ts"))).toBe(true);
    const report = validateWorkspaceSkills(root, skills);
    expect(report.errors).toEqual([]);
    expect(() => generateScript(root, skills, "demo", "run-it")).toThrow("already exists");
    expect(() => generateScript(root, skills, "demo", "Bad_Id")).toThrow("Invalid script id");
  });
});

describe("generate plugin (F-73)", () => {
  test("scaffolds a module plus a passing contract test and registers it", async () => {
    const root = workspace();
    const { text, registered } = generatePlugin(root, "ssf-plugin-toc");
    expect(registered).toBe(true);
    expect(text).toContain("plugins/ssf-plugin-toc.mjs");
    expect(existsSync(join(root, "plugins", "ssf-plugin-toc.mjs"))).toBe(true);
    expect(existsSync(join(root, "plugins", "ssf-plugin-toc.contract.test.ts"))).toBe(true);
    expect(readFileSync(join(root, "ssf.config.ts"), "utf8")).toContain("./plugins/ssf-plugin-toc.mjs");
    // The scaffolded plugin passes the same contract suite the build runs.
    const module = (await import(join(root, "plugins", "ssf-plugin-toc.mjs"))) as { default: unknown };
    const { normalizePlugin } = await import("@ssf/plugin-api");
    const plugin = normalizePlugin(module.default as never);
    expect(validatePlugin(plugin)).toEqual([]);
    const results = await runContractTests(plugin);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(await validatePluginSpecs(root, ["./plugins/ssf-plugin-toc.mjs"])).toEqual([]);
    expect(() => generatePlugin(root, "ssf-plugin-toc")).toThrow("already exists");
    expect(() => generatePlugin(root, "Bad_Name")).toThrow("Invalid plugin name");
  }, 60000);
});

describe("plugins list (F-80)", () => {
  test("lists active plugins with versions and capabilities", async () => {
    const root = workspace();
    expect(await listWorkspacePlugins(root, [])).toEqual([]);
    generatePlugin(root, "ssf-plugin-toc");
    const entries = await listWorkspacePlugins(root, ["./plugins/ssf-plugin-toc.mjs"]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ spec: "./plugins/ssf-plugin-toc.mjs", name: "ssf-plugin-toc", version: "local", apiVersion: 1 });
  }, 60000);
});
