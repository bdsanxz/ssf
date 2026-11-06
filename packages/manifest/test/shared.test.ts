// F-07 tests: shared code declarations.

import { describe, expect, test } from "bun:test";
import { isSharedDeclared, isSharedPath, validateSharedSection } from "../src/shared.js";
import type { SkillManifest } from "../src/types.js";

function manifestWith(shared: Array<{ path: string }>): SkillManifest {
  return {
    skill: { id: "demo", version: "1.0.0", description: "Demo skill. Use when testing." },
    shared,
  };
}

describe("isSharedPath", () => {
  test("accepts paths inside shared/", () => {
    expect(isSharedPath("shared/lib/a.ts")).toBe(true);
    expect(isSharedPath("shared")).toBe(true);
  });

  test("rejects skill paths and escapes", () => {
    expect(isSharedPath("skills/other/src/a.ts")).toBe(false);
    expect(isSharedPath("../shared/a.ts")).toBe(false);
    expect(isSharedPath("/shared/a.ts")).toBe(false);
  });
});

describe("validateSharedSection", () => {
  test("accepts declared shared files", () => {
    const errors = validateSharedSection(manifestWith([{ path: "shared/lib/a.ts" }]));
    expect(errors).toEqual([]);
  });

  test("rejects references to other skills", () => {
    const errors = validateSharedSection(manifestWith([{ path: "skills/other/src/a.ts" }]));
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("another skill");
  });

  test("rejects escapes and duplicates", () => {
    const errors = validateSharedSection(
      manifestWith([{ path: "../shared/a.ts" }, { path: "shared/lib/a.ts" }, { path: "shared/lib/a.ts" }]),
    );
    expect(errors.length).toBe(2);
  });
});

describe("isSharedDeclared", () => {
  test("matches exact declared paths only", () => {
    const manifest = manifestWith([{ path: "shared/lib/a.ts" }]);
    expect(isSharedDeclared(manifest, "shared/lib/a.ts")).toBe(true);
    expect(isSharedDeclared(manifest, "shared/lib/b.ts")).toBe(false);
  });
});
