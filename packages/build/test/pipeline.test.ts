// F-21, F-24, F-29, F-30, F-31, F-33 tests: full pipeline behavior.
// Builds a fixture skill twice and checks determinism, layout, the public
// manifest, release immutability, stage gates, and key requirements.

import { describe, expect, test } from "bun:test";
import { generateSigningKeypair, generateRootSecret } from "@ssf/crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildAllSkills, buildSkill, BuildError, type ArtifactKeys, type SkillBuildPlan } from "../src/pipeline.js";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const SKILL_MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for pipeline tests. Use when testing builds.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "shared:",
  "  - path: shared/lib/util.ts",
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

function keys(): ArtifactKeys {
  const pair = generateSigningKeypair();
  const material = generateRootSecret();
  return {
    rootSecret: material,
    rootKid: "prod-2026",
    artifactPrivateKey: pair.privateKey,
    artifactKid: "prod-2026",
    licensePublicKey: generateSigningKeypair().publicKey,
  };
}

function fixtureWorkspace(options: { declareShared?: boolean } = {}): string {
  const root = join(tmpdir(), `ssf-pipe-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  mkdirSync(join(root, "shared", "lib"), { recursive: true });
  const manifest = options.declareShared === false
    ? SKILL_MANIFEST.replace("  - path: shared/lib/util.ts\n", "")
    : SKILL_MANIFEST;
  writeFileSync(join(skill, "skill.manifest"), manifest);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(
    join(skill, "src", "run.ts"),
    "import { helper } from \"../../../shared/lib/util.js\";\nexport function run(input: string): string {\n  return helper(input);\n}\n",
  );
  writeFileSync(join(skill, "references", "public.md"), "Public guide text.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "Top secret know-how for pipeline tests.\n");
  writeFileSync(join(root, "shared", "lib", "util.ts"), "export function helper(input: string): string {\n  return `helped:${input}`;\n}\n");
  return root;
}

function plan(root: string, keyMaterial: ArtifactKeys, manifestOverride?: SkillManifest): SkillBuildPlan {
  const manifest = manifestOverride ?? (parseYaml(readFileSync(join(root, "skills", "demo", "skill.manifest"), "utf8")) as SkillManifest);
  return { workspaceDir: root, skillDir: join("skills", "demo"), manifest, config: config(), keys: keyMaterial };
}

function readPackage(outDir: string): Record<string, Buffer> {
  const names = ["SKILL.md", "skill.manifest", join("references", "public.md"), join("scripts", "runtime.js"), join("scripts", "runtime.bin")];
  const files: Record<string, Buffer> = {};
  for (const name of names) {
    files[name] = readFileSync(join(outDir, name));
  }
  return files;
}

describe("buildSkill", () => {
  test("builds deterministically: two builds are byte-identical (F-24)", async () => {
    const root = fixtureWorkspace();
    const keyMaterial = keys();
    const first = await buildSkill(plan(root, keyMaterial));
    const before = readPackage(first.outDir);
    const second = await buildSkill(plan(root, keyMaterial));
    const after = readPackage(second.outDir);
    expect(second.hash).toBe(first.hash);
    for (const name of Object.keys(before)) {
      expect(after[name]?.equals(before[name] as Buffer)).toBe(true);
    }
  }, 120000);

  test("writes the dist layout with matching folder and frontmatter names (F-30)", async () => {
    const root = fixtureWorkspace();
    const result = await buildSkill(plan(root, keys()));
    expect(result.outDir.endsWith(join("dist", "skills", "demo"))).toBe(true);
    const skillMd = readFileSync(join(result.outDir, "SKILL.md"), "utf8");
    expect(skillMd).toContain("name: demo");
    expect(skillMd).toContain("<!-- ssf:begin -->");
    expect(skillMd).toContain("Author text.");
  }, 120000);

  test("ships a public-only manifest (F-29)", async () => {
    const root = fixtureWorkspace();
    const result = await buildSkill(plan(root, keys()));
    const text = readFileSync(join(result.outDir, "skill.manifest"), "utf8");
    const shipped = parseYaml(text) as SkillManifest;
    expect(shipped.scripts).toBeUndefined();
    expect((shipped.companion_files ?? []).map((file) => file.path)).toEqual(["references/public.md"]);
    expect(text).not.toContain("secrets/notes.md");
    expect(text).not.toContain("Internal notes");
    expect(text).not.toContain("run-demo");
  }, 120000);

  test("rejects changed content for a released version without force (F-31)", async () => {
    const root = fixtureWorkspace();
    await buildSkill(plan(root, keys()));
    writeFileSync(join(root, "skills", "demo", "secrets", "notes.md"), "Different secret content.\n");
    const retry = plan(root, keys());
    await expect(buildSkill(retry)).rejects.toThrow(BuildError);
    const forced = await buildSkill({ ...retry, options: { force: true } });
    expect(forced.hash).toBeDefined();
  }, 120000);

  test("fails when typecheck or test stages fail (F-33)", async () => {
    const root = fixtureWorkspace();
    const keyMaterial = keys();
    const badTypecheck = plan(root, keyMaterial);
    badTypecheck.options = { stages: { typecheck: () => { throw new Error("tsc boom"); } } };
    await expect(buildSkill(badTypecheck)).rejects.toThrow(BuildError);
    const badTests = plan(root, keyMaterial);
    badTests.options = { stages: { tests: async () => { throw new Error("tests boom"); } } };
    await expect(buildSkill(badTests)).rejects.toThrow(BuildError);
  }, 120000);

  test("refuses test kids and short root secrets", async () => {
    const root = fixtureWorkspace();
    const devKeys = keys();
    devKeys.rootKid = "dev";
    await expect(buildSkill(plan(root, devKeys))).rejects.toThrow(BuildError);
    const shortKeys = keys();
    shortKeys.rootSecret = shortKeys.rootSecret.subarray(0, 16);
    await expect(buildSkill(plan(root, shortKeys))).rejects.toThrow(BuildError);
  }, 120000);

  test("rejects scripts bundling undeclared shared files", async () => {
    const root = fixtureWorkspace({ declareShared: false });
    await expect(buildSkill(plan(root, keys()))).rejects.toThrow(BuildError);
  }, 120000);
});

describe("buildAllSkills", () => {
  test("builds skills independently: one failure keeps the other", async () => {
    const root = fixtureWorkspace();
    mkdirSync(join(root, "skills", "broken"), { recursive: true });
    writeFileSync(join(root, "skills", "broken", "skill.manifest"), "skill:\n  id: Bad!\n");
    const outcomes = await buildAllSkills(root, [join("skills", "demo"), join("skills", "broken")], config(), keys());
    expect(outcomes.find((o) => o.dir === join("skills", "demo"))?.ok).toBe(true);
    expect(outcomes.find((o) => o.dir === join("skills", "broken"))?.ok).toBe(false);
  }, 120000);
});
