// F-89: templates render deterministically with substituted names.
import { describe, expect, test } from "bun:test";
import {
  renderPluginTemplate,
  renderReferenceTemplate,
  renderScriptTemplate,
  renderSkillTemplate,
  renderWorkspaceTemplate,
} from "../src/index.js";

describe("renderWorkspaceTemplate", () => {
  test("renders config and gitignore with the publisher and env", () => {
    const files = renderWorkspaceTemplate({ workspace: "acme-skills", publisher: "acme", env: "ACME_SSF_LICENSE" });
    expect(files.map((file) => file.path).sort()).toEqual([".gitignore", "ssf.config.ts"]);
    const config = files.find((file) => file.path === "ssf.config.ts")!.content;
    expect(config).toContain("publisher: 'acme'");
    expect(config).toContain("ACME_SSF_LICENSE");
    expect(config).not.toContain("{{");
    const gitignore = files.find((file) => file.path === ".gitignore")!.content;
    expect(gitignore).toContain("keys/");
  });

  test("same inputs render identical bytes", () => {
    const vars = { workspace: "w", publisher: "p", env: "E" };
    expect(renderWorkspaceTemplate(vars)).toEqual(renderWorkspaceTemplate(vars));
  });
});

describe("renderSkillTemplate", () => {
  test("renders a scaffold with the skill name and no placeholders left", () => {
    const files = renderSkillTemplate({ name: "pdf-helper", publisher: "acme", env: "ACME_SSF_LICENSE" });
    expect(files.map((file) => file.path).sort()).toEqual([
      "SKILL.md",
      "references/guide.md",
      "skill.manifest",
      "src/example.ts",
      "test/smoke.test.ts",
    ]);
    for (const file of files) {
      expect(file.content).not.toContain("{{");
    }
    const manifest = files.find((file) => file.path === "skill.manifest")!.content;
    expect(manifest).toContain("id: pdf-helper");
    const skillMd = files.find((file) => file.path === "SKILL.md")!.content;
    expect(skillMd).toContain("# pdf-helper");
  });
});

describe("renderReferenceTemplate", () => {
  test("renders a stub with the skill and name and no placeholders left", () => {
    const files = renderReferenceTemplate({ skill: "demo", name: "topic" });
    expect(files.map((file) => file.path)).toEqual(["topic.md"]);
    expect(files[0]!.content).toContain("demo");
    expect(files[0]!.content).not.toContain("{{");
  });
});

describe("renderScriptTemplate", () => {
  test("renders an execute-only stub with the id and skill", () => {
    const files = renderScriptTemplate({ skill: "demo", id: "run-it" });
    expect(files.map((file) => file.path)).toEqual(["run-it.ts"]);
    expect(files[0]!.content).toContain("run-it");
    expect(files[0]!.content).toContain("process.argv");
    expect(files[0]!.content).not.toContain("{{");
  });
});

describe("renderPluginTemplate", () => {
  test("renders a module plus contract test with the plugin name", () => {
    const files = renderPluginTemplate({ name: "ssf-plugin-toc" });
    expect(files.map((file) => file.path).sort()).toEqual(["ssf-plugin-toc.contract.test.ts", "ssf-plugin-toc.mjs"]);
    for (const file of files) {
      expect(file.content).toContain("ssf-plugin-toc");
      expect(file.content).not.toContain("{{");
    }
    const module = files.find((file) => file.path === "ssf-plugin-toc.mjs")!.content;
    expect(module).toContain("apiVersion: 1");
    const contract = files.find((file) => file.path === "ssf-plugin-toc.contract.test.ts")!.content;
    expect(contract).toContain("runContractTests");
  });
});
