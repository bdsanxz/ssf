// F-12 tests: protection tiers 0-2 (F-94 binaries under protected tiers).

import { describe, expect, test } from "bun:test";
import {
  assertTierAllowsContent,
  isProtectedTier,
  isUtf8Text,
  normalizeProtectionTier,
  TierError,
} from "../src/tiers.js";

describe("normalizeProtectionTier", () => {
  test("defaults to none and accepts MVP tiers", () => {
    expect(normalizeProtectionTier(undefined, "a.md")).toBe("none");
    expect(normalizeProtectionTier("obfuscated", "a.md")).toBe("obfuscated");
    expect(normalizeProtectionTier("encrypted", "a.md")).toBe("encrypted");
  });

  test("rejects remote and unknown tiers", () => {
    expect(() => normalizeProtectionTier("remote", "a.md")).toThrow(TierError);
    expect(() => normalizeProtectionTier("vault", "a.md")).toThrow(TierError);
  });
});

describe("isUtf8Text", () => {
  test("accepts text and rejects binary", () => {
    expect(isUtf8Text(Buffer.from("hello", "utf8"))).toBe(true);
    expect(isUtf8Text(Buffer.from([0xff, 0xfe, 0x00, 0x01]))).toBe(false);
  });
});

describe("assertTierAllowsContent", () => {
  test("allows binaries under protected tiers and text at any tier", () => {
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0xff]);
    expect(() => assertTierAllowsContent("none", binary, "assets/logo.png")).not.toThrow();
    expect(() => assertTierAllowsContent("encrypted", binary, "assets/logo.png")).not.toThrow();
    expect(() => assertTierAllowsContent("obfuscated", binary, "assets/logo.png")).not.toThrow();
    expect(() =>
      assertTierAllowsContent("encrypted", Buffer.from("secret notes", "utf8"), "notes.md"),
    ).not.toThrow();
  });
});

describe("isProtectedTier", () => {
  test("marks only non-none tiers as protected", () => {
    expect(isProtectedTier("none")).toBe(false);
    expect(isProtectedTier("obfuscated")).toBe(true);
    expect(isProtectedTier("encrypted")).toBe(true);
  });
});
