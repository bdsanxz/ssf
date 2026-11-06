// F-27 tests: generated frontmatter.

import { describe, expect, test } from "bun:test";
import {
  buildCompatibility,
  generateFrontmatterData,
  renderFrontmatter,
  splitFrontmatter,
  validateFrontmatter,
} from "../src/frontmatter.js";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

function manifest(): SkillManifest {
  return {
    skill: {
      id: "pdf-helper",
      version: "1.0.0",
      description: "Extracts tables. Use when the user mentions PDF.",
      license: "Proprietary",
      metadata: { "acme-team": "docs" },
    },
    license: { mode: "offline" },
  };
}

function config(): Pick<SsfConfig, "workspace" | "license" | "agent"> {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    agent: { confidentialityNotice: { enabled: true } },
  };
}

describe("generateFrontmatterData", () => {
  test("maps skill fields and stamps framework metadata", () => {
    const data = generateFrontmatterData(manifest(), config());
    expect(data.name).toBe("pdf-helper");
    expect(data.license).toBe("Proprietary");
    expect(data.metadata["ssf-publisher"]).toBe("acme");
    expect(data.metadata["ssf-version"]).toBe("1.0.0");
    expect(data.metadata["ssf-format"]).toBe("1");
    expect(data.metadata["acme-team"]).toBe("docs");
    expect(data.compatibility.length).toBeLessThanOrEqual(500);
    expect(data.compatibility).toContain("ACME_SSF_LICENSE");
  });

  test("omits license when empty and honors allowed-tools opt-in", () => {
    const without = manifest();
    delete without.skill.license;
    const data = generateFrontmatterData(without, config());
    expect(data.license).toBeUndefined();
    expect(data.allowedTools).toBeUndefined();
    const opted = config();
    opted.agent = { confidentialityNotice: { enabled: true }, allowedTools: "Bash(node:*)" };
    expect(generateFrontmatterData(without, opted).allowedTools).toBe("Bash(node:*)");
  });

  test("mentions network needs for online mode", () => {
    expect(buildCompatibility("online", "ACME_SSF_LICENSE")).toContain("network");
    expect(buildCompatibility("offline", "ACME_SSF_LICENSE")).toContain("no network");
  });
});

describe("renderFrontmatter", () => {
  test("emits fenced YAML that validates", () => {
    const text = renderFrontmatter(generateFrontmatterData(manifest(), config()));
    expect(text.startsWith("---\n")).toBe(true);
    expect(validateFrontmatter(text)).toEqual([]);
  });

  test("quotes values containing colons safely", () => {
    const tricky = manifest();
    tricky.skill.description = "Reads PDFs: tables, forms, and text. Use when asked.";
    const text = renderFrontmatter(generateFrontmatterData(tricky, config()));
    expect(validateFrontmatter(text)).toEqual([]);
  });
});

describe("splitFrontmatter", () => {
  test("splits head matter from the body", () => {
    const text = "---\nname: x\n---\n\n# Title\n";
    const split = splitFrontmatter(text);
    expect(split.frontmatter).toContain("name: x");
    expect(split.body).toBe("\n# Title\n");
  });

  test("returns the whole text when no fence exists", () => {
    expect(splitFrontmatter("# Title\n")).toEqual({ frontmatter: null, body: "# Title\n" });
  });
});

describe("validateFrontmatter", () => {
  test("rejects unknown fields and oversized values", () => {
    expect(validateFrontmatter("name: pdf-helper\ncustom: 1\n")).toContain(
      "Unknown top-level frontmatter field: custom",
    );
    expect(validateFrontmatter(`name: pdf-helper\ndescription: ${"x".repeat(2000)}\n`)).not.toEqual([]);
  });
});
