// F-86/F-91: logical path conversion and validation.
import { describe, expect, test } from "bun:test";
import { isValidLogicalPath, toLogicalPath } from "../src/manifest.js";

describe("toLogicalPath", () => {
  test("converts Windows separators and drive prefixes", () => {
    expect(toLogicalPath("references\\guide.md")).toBe("references/guide.md");
    expect(toLogicalPath("C:/skills/demo/references/a.md")).toBe("skills/demo/references/a.md");
    expect(toLogicalPath("./references/a.md")).toBe("references/a.md");
    expect(toLogicalPath("references/guide.md")).toBe("references/guide.md");
  });
});

describe("isValidLogicalPath", () => {
  test("rejects traversal, absolute paths, and backslashes", () => {
    expect(isValidLogicalPath("references/guide.md")).toBe(true);
    expect(isValidLogicalPath("../secret")).toBe(false);
    expect(isValidLogicalPath("a/../../b")).toBe(false);
    expect(isValidLogicalPath("/abs/path")).toBe(false);
    expect(isValidLogicalPath("back\\slash")).toBe(false);
    expect(isValidLogicalPath("")).toBe(false);
  });
});
