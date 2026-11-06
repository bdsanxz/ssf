// F-23: minification before obfuscation.
// Minify runs on every bundled script and on the runtime loader, always
// before obfuscation. esbuild minification is deterministic for fixed
// input, so this stage preserves byte-identical release builds.

import { transformSync } from "esbuild";

/** Minify bundled JavaScript. Throws on syntax errors. */
export function minifyJs(code: string): string {
  if (code.length === 0) {
    throw new Error("Cannot minify an empty source.");
  }
  return transformSync(code, { loader: "js", minify: true }).code;
}
