// F-09 tests: companion declarations, notice defaults, and limits.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveCompanionLimits,
  effectiveNotice,
  findMissingCompanionFiles,
  validateCompanionEntry,
} from "../src/companions.js";
import type { SkillManifest, SsfConfig } from "../src/types.js";

function config(): Pick<SsfConfig, "limits"> {
  return {
    limits: {
      defaultMaxLines: 500,
      defaultMaxChars: 40000,
      defaultScriptOutputChars: 20000,
      defaultScriptTimeoutSeconds: 120,
    },
  };
}

describe("validateCompanionEntry", () => {
  test("accepts a well-formed entry", () => {
    expect(
      validateCompanionEntry({ path: "references/a.md", protection: "encrypted", description: "Guide" }),
    ).toEqual([]);
  });

  test("rejects multiline descriptions and bad values", () => {
    const errors = validateCompanionEntry({
      path: "references/a.md",
      description: "line one\nline two",
      max_chars: 0,
      confidentiality_notice: "yes" as unknown as boolean,
    });
    expect(errors.length).toBe(3);
  });
});

describe("effectiveNotice", () => {
  test("defaults to true for protected files and false for public ones", () => {
    expect(effectiveNotice("encrypted")).toBe(true);
    expect(effectiveNotice("obfuscated")).toBe(true);
    expect(effectiveNotice("none")).toBe(false);
  });

  test("explicit values always win", () => {
    expect(effectiveNotice("encrypted", false)).toBe(false);
    expect(effectiveNotice("none", true)).toBe(true);
  });
});

describe("effectiveCompanionLimits", () => {
  test("entry beats manifest beats workspace, capped at 500 lines", () => {
    const manifest: SkillManifest = {
      skill: { id: "demo", version: "1.0.0", description: "Demo skill. Use when testing." },
      limits: { default_max_lines: 300, default_max_chars: 10000 },
    };
    const fromManifest = effectiveCompanionLimits({ path: "a.md" }, manifest, config());
    expect(fromManifest.maxLines).toBe(300);
    expect(fromManifest.maxChars).toBe(10000);
    expect(fromManifest.notice).toBe(false);

    const fromEntry = effectiveCompanionLimits(
      { path: "a.md", protection: "encrypted", max_lines: 600, max_chars: 5000 },
      manifest,
      config(),
    );
    expect(fromEntry.maxLines).toBe(500);
    expect(fromEntry.maxChars).toBe(5000);
    expect(fromEntry.notice).toBe(true);
  });
});

describe("findMissingCompanionFiles", () => {
  test("lists manifest paths missing from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "ssf-skill-"));
    mkdirSync(join(root, "references"), { recursive: true });
    writeFileSync(join(root, "references/present.md"), "hi");
    const manifest: SkillManifest = {
      skill: { id: "demo", version: "1.0.0", description: "Demo skill. Use when testing." },
      companion_files: [{ path: "references/present.md" }, { path: "references/absent.md" }],
    };
    expect(findMissingCompanionFiles(root, manifest)).toEqual(["references/absent.md"]);
  });
});
