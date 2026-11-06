// F-10 tests: script declarations referenced by id.

import { describe, expect, test } from "bun:test";
import {
  effectiveScriptLimits,
  findScriptById,
  findScriptPathReferences,
  validateScriptEntry,
} from "../src/scripts.js";
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

function entry() {
  return { id: "extract-table", entry: "src/extract-table.ts", description: "Extract tables", usage: "<file.pdf>" };
}

describe("validateScriptEntry", () => {
  test("accepts a well-formed entry", () => {
    expect(validateScriptEntry(entry())).toEqual([]);
  });

  test("rejects bad ids, bad entries, and missing description or usage", () => {
    const errors = validateScriptEntry({
      id: "Bad_Id!",
      entry: "../outside.ts",
      description: "",
      usage: "",
      max_output_chars: 0,
      timeout_seconds: -5,
    });
    expect(errors.length).toBe(6);
  });
});

describe("findScriptById", () => {
  test("finds registered ids only", () => {
    const manifest: SkillManifest = {
      skill: { id: "demo", version: "1.0.0", description: "Demo skill. Use when testing." },
      scripts: [entry()],
    };
    expect(findScriptById(manifest, "extract-table")?.entry).toBe("src/extract-table.ts");
    expect(findScriptById(manifest, "missing")).toBeUndefined();
  });
});

describe("effectiveScriptLimits", () => {
  test("falls back to workspace defaults when omitted", () => {
    const resolved = effectiveScriptLimits(entry(), config());
    expect(resolved).toEqual({ maxOutputChars: 20000, timeoutSeconds: 120 });
    const custom = effectiveScriptLimits({ ...entry(), max_output_chars: 5000, timeout_seconds: 30 }, config());
    expect(custom).toEqual({ maxOutputChars: 5000, timeoutSeconds: 30 });
  });
});

describe("findScriptPathReferences", () => {
  test("flags entry paths leaked into text but not id references", () => {
    const manifest: SkillManifest = {
      skill: { id: "demo", version: "1.0.0", description: "Demo skill. Use when testing." },
      scripts: [entry()],
    };
    expect(findScriptPathReferences("See src/extract-table.ts for details.", manifest)).toEqual([
      "src/extract-table.ts",
    ]);
    expect(findScriptPathReferences("Run `run extract-table` with <file.pdf>.", manifest)).toEqual([]);
  });
});
