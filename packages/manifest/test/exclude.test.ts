// F-11 tests: exclude pattern matching.

import { describe, expect, test } from "bun:test";
import { isExcluded, partitionExcluded } from "../src/exclude.js";

describe("isExcluded", () => {
  test("matches proposal examples at any depth", () => {
    expect(isExcluded("src/a.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(isExcluded("a.test.ts", ["**/*.test.ts"])).toBe(true);
    expect(isExcluded("src/a.ts", ["**/*.test.ts"])).toBe(false);
    expect(isExcluded(".DS_Store", ["**/.DS_Store"])).toBe(true);
    expect(isExcluded("docs/.DS_Store", ["**/.DS_Store"])).toBe(true);
  });

  test("keeps * inside one segment and supports ?", () => {
    expect(isExcluded("src/a.ts", ["src/*.ts"])).toBe(true);
    expect(isExcluded("src/nested/a.ts", ["src/*.ts"])).toBe(false);
    expect(isExcluded("src/nested/a.ts", ["src/**/*.ts"])).toBe(true);
    expect(isExcluded("src/a1.ts", ["src/a?.ts"])).toBe(true);
    expect(isExcluded("src/abc.ts", ["src/a?.ts"])).toBe(false);
  });

  test("matches bare file names at any depth", () => {
    expect(isExcluded("dist/Thumbs.db", ["Thumbs.db"])).toBe(true);
    expect(isExcluded("Thumbs.db", ["Thumbs.db"])).toBe(true);
  });
});

describe("partitionExcluded", () => {
  test("splits kept and excluded paths", () => {
    const result = partitionExcluded(["src/a.ts", "src/a.test.ts", "docs/.DS_Store"], ["**/*.test.ts", "**/.DS_Store"]);
    expect(result.kept).toEqual(["src/a.ts"]);
    expect(result.excluded).toEqual(["src/a.test.ts", "docs/.DS_Store"]);
  });
});
