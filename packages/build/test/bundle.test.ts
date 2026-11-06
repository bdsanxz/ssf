// F-22 and F-23 tests: bundling and minification.

import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleEntryFile } from "../src/bundle.js";
import { minifyJs } from "../src/minify.js";

function fixture(): { dir: string; entry: string } {
  const dir = join(tmpdir(), `ssf-bundle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "helper.ts"), "export function helper(value: string): string {\n  return `helped:${value}`;\n}\n");
  writeFileSync(
    join(dir, "src", "entry.ts"),
    "import { helper } from \"./helper.js\";\nexport function run(input: string): string {\n  return helper(input);\n}\n",
  );
  return { dir, entry: join(dir, "src", "entry.ts") };
}

describe("bundleEntryFile", () => {
  test("bundles imports into one sourcemap-free unit", async () => {
    const { dir, entry } = fixture();
    const first = await bundleEntryFile(entry, { resolveDir: dir });
    const second = await bundleEntryFile(entry, { resolveDir: dir });
    expect(first.code).toBe(second.code);
    expect(first.code).toContain("helped:");
    expect(first.code).not.toContain("sourceMappingURL");
    expect(first.code).not.toContain("./helper");
    expect(first.inputs.some((input) => input.endsWith("src/helper.ts"))).toBe(true);
  });
});

describe("minifyJs", () => {
  test("shrinks code deterministically", () => {
    const source = "function add(first, second) {\n  return first + second;\n}\n";
    const once = minifyJs(source);
    expect(minifyJs(source)).toBe(once);
    expect(once.length).toBeLessThan(source.length);
    expect(once).toContain("return");
  });

  test("rejects empty sources", () => {
    expect(() => minifyJs("")).toThrow();
  });
});
