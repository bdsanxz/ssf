// F-28 tests: generated ssf block.

import { describe, expect, test } from "bun:test";
import { applySsfBlock, generateSsfBlock, SSF_BEGIN, SSF_END } from "../src/ssfBlock.js";
import type { SkillManifest } from "@ssf/manifest";

function manifest(withScripts: boolean, withProtected: boolean): SkillManifest {
  return {
    skill: { id: "demo", version: "1.0.0", description: "Demo skill. Use when testing." },
    scripts: withScripts
      ? [{ id: "run-it", entry: "src/run.ts", description: "Run it", usage: "<input>" }]
      : [],
    companion_files: withProtected ? [{ path: "secret.md", protection: "encrypted" }] : [],
  };
}

describe("generateSsfBlock", () => {
  test("includes script and confidentiality sections only when relevant", () => {
    const full = generateSsfBlock(manifest(true, true));
    expect(full).toContain("## Scripts");
    expect(full).toContain("run <id>");
    expect(full).toContain("## Confidentiality");

    const bare = generateSsfBlock(manifest(false, false));
    expect(bare).not.toContain("## Scripts");
    expect(bare).not.toContain("## Confidentiality");
    expect(bare).toContain("## License errors");
  });

  test("never leaks protected paths or script entries", () => {
    const block = generateSsfBlock(manifest(true, true));
    expect(block).not.toContain("secret.md");
    expect(block).not.toContain("src/run.ts");
  });

  test("supports the proposal Indonesian template", () => {
    const block = generateSsfBlock(manifest(true, true), { lang: "id" });
    expect(block).toContain("## Akses resource");
    expect(block).toContain("## Error lisensi");
  });
});

describe("applySsfBlock", () => {
  test("appends the block when markers are absent", () => {
    const out = applySsfBlock("# Demo\n", "BODY");
    expect(out).toContain("# Demo");
    expect(out).toContain(SSF_BEGIN);
    expect(out).toContain(SSF_END);
  });

  test("replaces the old block and preserves outside content", () => {
    const before = `# Demo\n\nIntro.\n\n${SSF_BEGIN}\nOLD\n${SSF_END}\n\nOutro.\n`;
    const out = applySsfBlock(before, "NEW");
    expect(out).toContain("Intro.");
    expect(out).toContain("Outro.");
    expect(out).toContain("NEW");
    expect(out).not.toContain("OLD");
  });
});
