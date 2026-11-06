// F-18: obfuscation wiring.
// Scripts and runtime.js are obfuscated with javascript-obfuscator using the
// release seed. Tier-1 protected text uses a reversible encoding that is
// explicitly NOT security (a custom ResourceCodec plugin may replace it per
// F-64). Honest security: obfuscation is a deterrent, never a boundary, and
// third-party scanner compatibility is not a target.

import JavaScriptObfuscator from "javascript-obfuscator";

export interface ObfuscateOptions {
  /** Release seed; different seeds give different identifier renaming. */
  seed: number;
  compact?: boolean;
}

/**
 * Obfuscate JavaScript source deterministically for a given seed. The seed
 * drives identifier renaming (F-25b2), numeric literal shapes, and object
 * key transforms, so each release seed yields a structurally different
 * bundle with identical behavior. String literals are never encoded or
 * split: embedded names must stay greppable for audit and tests.
 */
export function obfuscateJavaScript(source: string, options: ObfuscateOptions): string {
  if (source.length === 0) {
    throw new Error("Cannot obfuscate an empty source.");
  }
  const result = JavaScriptObfuscator.obfuscate(source, {
    seed: options.seed,
    compact: options.compact ?? true,
    // Rename top-level identifiers too; without this, entry function names
    // survive obfuscation and leak into extracted sources.
    renameGlobals: true,
    // Seed-varying numeric shapes; string values are left alone.
    numbersToExpressions: true,
    // Seed-varying property access shapes; string values are left alone.
    transformObjectKeys: true,
  });
  return result.getObfuscatedCode();
}

/** Marker prefix for tier-1 encoded text. Decoding only needs the prefix. */
export const TIER1_PREFIX = "ssf1:";

/**
 * Encode tier-1 protected text. This is base64, not encryption: anyone can
 * decode it. It only hides content from casual reading.
 */
export function encodeTier1Text(plaintext: string): string {
  return `${TIER1_PREFIX}${Buffer.from(plaintext, "utf8").toString("base64")}`;
}

/** Decode tier-1 protected text. Throws on a missing prefix or bad base64. */
export function decodeTier1Text(encoded: string): string {
  if (!encoded.startsWith(TIER1_PREFIX)) {
    throw new Error("Tier-1 text is missing the ssf1: prefix.");
  }
  return Buffer.from(encoded.slice(TIER1_PREFIX.length), "base64").toString("utf8");
}
