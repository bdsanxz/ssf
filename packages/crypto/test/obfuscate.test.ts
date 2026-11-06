// F-18 tests: obfuscation wiring and the tier-1 text codec.

import { describe, expect, test } from "bun:test";
import { decodeTier1Text, encodeTier1Text, obfuscateJavaScript } from "../src/obfuscate.js";

describe("obfuscateJavaScript", () => {
  test("is deterministic for one seed and hides identifiers", () => {
    const source = "function mySecretFunction(input) { return input + 1; }";
    const a = obfuscateJavaScript(source, { seed: 7 });
    const b = obfuscateJavaScript(source, { seed: 7 });
    expect(a).toBe(b);
    expect(a).not.toContain("mySecretFunction");
  });

  test("rejects empty sources", () => {
    expect(() => obfuscateJavaScript("", { seed: 1 })).toThrow();
  });
});

describe("tier-1 codec", () => {
  test("round-trips text with the ssf1 prefix", () => {
    const encoded = encodeTier1Text("hello world");
    expect(encoded.startsWith("ssf1:")).toBe(true);
    expect(decodeTier1Text(encoded)).toBe("hello world");
  });

  test("rejects input without the prefix", () => {
    expect(() => decodeTier1Text("aGVsbG8=")).toThrow();
  });
});
