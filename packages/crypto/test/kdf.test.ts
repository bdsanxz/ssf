// F-13 tests: root secret generation and HKDF key schedule.

import { describe, expect, test } from "bun:test";
import { deriveContentKey, deriveFileKey, generateRootSecret } from "../src/kdf.js";

describe("root secret", () => {
  test("generates 32 random bytes", () => {
    const a = generateRootSecret();
    const b = generateRootSecret();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(false);
  });
});

describe("content key", () => {
  test("is deterministic for the same inputs", () => {
    const root = generateRootSecret();
    expect(deriveContentKey(root, "pdf-helper", "1.0.0").equals(deriveContentKey(root, "pdf-helper", "1.0.0"))).toBe(true);
  });

  test("differs per skill and per version", () => {
    const root = generateRootSecret();
    const base = deriveContentKey(root, "pdf-helper", "1.0.0");
    expect(deriveContentKey(root, "report-writer", "1.0.0").equals(base)).toBe(false);
    expect(deriveContentKey(root, "pdf-helper", "1.0.1").equals(base)).toBe(false);
  });

  test("rejects a short root secret", () => {
    expect(() => deriveContentKey(Buffer.alloc(16), "pdf-helper", "1.0.0")).toThrow();
  });
});

describe("file key", () => {
  test("is deterministic per logical id and differs across ids", () => {
    const root = generateRootSecret();
    const content = deriveContentKey(root, "pdf-helper", "1.0.0");
    const a = deriveFileKey(content, "references/a.md");
    expect(a.equals(deriveFileKey(content, "references/a.md"))).toBe(true);
    expect(a.equals(deriveFileKey(content, "references/b.md"))).toBe(false);
  });
});
