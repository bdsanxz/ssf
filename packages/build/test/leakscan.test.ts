// F-32 tests: leak scan over finished packages.

import { describe, expect, test } from "bun:test";
import { generateSigningKeypair, generateRootSecret } from "@ssf/crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkill } from "../src/pipeline.js";
import { scanPackageForLeaks } from "../src/leakscan.js";
import type { SsfPlugin } from "@ssf/plugin-api";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

function config(): SsfConfig {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
    limits: {
      defaultMaxLines: 500,
      defaultMaxChars: 40000,
      defaultScriptOutputChars: 20000,
      defaultScriptTimeoutSeconds: 120,
    },
    agent: { confidentialityNotice: { enabled: true } },
    build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
    skills: ["skills/demo"],
    plugins: [],
  };
}

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for leak tests. Use when testing builds.",
  "  license: Proprietary",
  "",
  "companion_files:",
  "  - path: references/public.md",
  "    protection: none",
  "    description: Public guide",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Internal notes",
  "",
  "scripts:",
  "  - id: run-demo",
  "    entry: src/run.ts",
  "    description: Run the demo",
  "    usage: <input>",
  "",
].join("\n");

async function builtPackage(): Promise<{ outDir: string; manifest: SkillManifest }> {
  const root = join(tmpdir(), `ssf-leak-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "run.ts"), "export function run(input: string): string {\n  return `ran:${input}`;\n}\n");
  writeFileSync(join(skill, "references", "public.md"), "Public guide text.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "Leak-test secret know-how paragraph.\n");
  const pair = generateSigningKeypair();
  const material = generateRootSecret();
  const { parseSkillManifestText } = await import("@ssf/manifest");
  const manifest = parseSkillManifestText(MANIFEST);
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest,
    config: config(),
    keys: { rootSecret: material, rootKid: "prod-2026", artifactPrivateKey: pair.privateKey, artifactKid: "prod-2026", licensePublicKey: generateSigningKeypair().publicKey },
  });
  return { outDir: result.outDir, manifest };
}

describe("scanPackageForLeaks", () => {
  test("passes a clean pipeline package", async () => {
    const { outDir, manifest } = await builtPackage();
    expect(scanPackageForLeaks({ pkgDir: outDir, skillId: "demo", manifest, secretTexts: [] })).toEqual([]);
  }, 120000);

  test("catches protected plaintext copied into a public file", async () => {
    const { outDir, manifest } = await builtPackage();
    appendFileSync(join(outDir, "references", "public.md"), "Leak-test secret know-how paragraph.\n");
    const violations = scanPackageForLeaks({
      pkgDir: outDir,
      skillId: "demo",
      manifest,
      secretTexts: ["Leak-test secret know-how paragraph."],
    });
    expect(violations.some((v) => v.includes("Protected plaintext"))).toBe(true);
  }, 120000);

  test("catches shipped source maps", async () => {
    const { outDir, manifest } = await builtPackage();
    writeFileSync(join(outDir, "scripts", "run.js.map"), "{}");
    const violations = scanPackageForLeaks({ pkgDir: outDir, skillId: "demo", manifest, secretTexts: [] });
    expect(violations.some((v) => v.includes("Source map"))).toBe(true);
  }, 120000);

  test("catches a tampered container", async () => {
    const { outDir, manifest } = await builtPackage();
    const binPath = join(outDir, "scripts", "runtime.bin");
    const bytes = readFileSync(binPath);
    const last = bytes.length - 1;
    bytes[last] = ((bytes[last] ?? 0) ^ 0x01);
    writeFileSync(binPath, bytes);
    const violations = scanPackageForLeaks({ pkgDir: outDir, skillId: "demo", manifest, secretTexts: [] });
    expect(violations.some((v) => v.includes("runtime.bin"))).toBe(true);
  }, 120000);

  test("rejects plugins with a bad apiVersion at the final gate", async () => {
    const { outDir, manifest } = await builtPackage();
    const violations = scanPackageForLeaks({
      pkgDir: outDir,
      skillId: "demo",
      manifest,
      secretTexts: [],
      plugins: [{ name: "old", apiVersion: 0 } as unknown as SsfPlugin],
    });
    expect(violations.some((v) => v.includes("old") && v.includes("apiVersion"))).toBe(true);
  }, 120000);

  test("rejects failed plugin contract tests at the final gate", async () => {
    const { outDir, manifest } = await builtPackage();
    const violations = scanPackageForLeaks({
      pkgDir: outDir,
      skillId: "demo",
      manifest,
      secretTexts: [],
      plugins: [],
      contractTests: [{ hook: "codec-default:build.transformCompanion", passed: false }],
    });
    expect(violations.some((v) => v.includes("contract test failed"))).toBe(true);
  }, 120000);

  test("requires the releases log to cover the shipped hash", async () => {
    const { outDir, manifest } = await builtPackage();
    const { createHash } = await import("node:crypto");
    const shipped = createHash("sha256").update(readFileSync(join(outDir, "scripts", "runtime.bin"))).digest("hex");
    // outDir is <root>/dist/skills/<id>: the pipeline wrote releases.jsonl at the root.
    const releasesLog = join(outDir, "..", "..", "..", "releases.jsonl");
    const ok = scanPackageForLeaks({
      pkgDir: outDir,
      skillId: "demo",
      manifest,
      secretTexts: [],
      releasesLog,
      expectedHash: shipped,
    });
    expect(ok).toEqual([]);
    const stale = scanPackageForLeaks({
      pkgDir: outDir,
      skillId: "demo",
      manifest,
      secretTexts: [],
      releasesLog,
      expectedHash: "00".repeat(32),
    });
    expect(stale.some((v) => v.includes("Releases log"))).toBe(true);
  }, 120000);
});
