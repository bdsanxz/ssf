// F-25 tests: release seed diversification.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { deriveReleaseSeed, devSeed, pickSeeds, seedToUint32 } from "../src/diversify.js";

describe("deriveReleaseSeed", () => {
  test("is deterministic and differs per skill and version", () => {
    const root = randomBytes(32);
    const base = deriveReleaseSeed(root, "demo", "1.0.0");
    expect(base.length).toBe(32);
    expect(deriveReleaseSeed(root, "demo", "1.0.0").equals(base)).toBe(true);
    expect(deriveReleaseSeed(root, "other", "1.0.0").equals(base)).toBe(false);
    expect(deriveReleaseSeed(root, "demo", "2.0.0").equals(base)).toBe(false);
  });

  test("rejects short root secrets", () => {
    expect(() => deriveReleaseSeed(randomBytes(16), "demo", "1.0.0")).toThrow();
  });
});

describe("seedToUint32", () => {
  test("folds seeds into the uint32 range", () => {
    const value = seedToUint32(deriveReleaseSeed(randomBytes(32), "demo", "1.0.0"));
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("pickSeeds", () => {
  test("derives the obfuscator seed by default and honors overrides", () => {
    const root = randomBytes(32);
    const picked = pickSeeds(root, "demo", "1.0.0");
    expect(picked.dev).toBe(false);
    expect(picked.obfuscatorSeed).toBe(seedToUint32(deriveReleaseSeed(root, "demo", "1.0.0")));
    expect(pickSeeds(root, "demo", "1.0.0", { seedOverride: 42 }).obfuscatorSeed).toBe(42);
  });

  test("dev seeds stay in range", () => {
    expect(devSeed()).toBeGreaterThanOrEqual(0);
    expect(devSeed()).toBeLessThanOrEqual(0xffffffff);
  });
});
