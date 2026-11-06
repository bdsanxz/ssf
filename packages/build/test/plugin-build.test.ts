// F-64: build-time plugin hooks (transformSource, transformCompanion,
// lifecycle, validation gates). Real builds with custom in-process plugins.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateRootSecret, generateSigningKeypair } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import type { SsfPlugin } from "@ssf/plugin-api";
import { buildSkill, BuildError } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for build plugin tests. Use when testing hooks.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Internal notes",
  "",
  "  - path: secrets/hint.md",
  "    protection: obfuscated",
  "    description: Casual hint",
  "",
  "scripts:",
  "  - id: echo-tag",
  "    entry: src/echo.ts",
  "    description: Echo the tag",
  "    usage: nothing",
  "",
].join("\n");

const RUN_TS = "const TAG = \"ORIGINAL\";\nconsole.log(TAG);\n";

function keys() {
  const license = generateSigningKeypair();
  const artifact = generateSigningKeypair();
  return {
    rootSecret: generateRootSecret(),
    licensePrivateKey: license.privateKey,
    licensePublicKey: license.publicKey,
    artifactPrivateKey: artifact.privateKey,
    artifactPublicKey: artifact.publicKey,
  };
}

function config(): SsfConfig {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
    limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
    agent: { confidentialityNotice: { enabled: true } },
    build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
    skills: ["skills/demo"],
    plugins: [],
  };
}

async function buildFixture(extra: { plugins?: SsfPlugin[] } = {}) {
  const root = join(tmpdir(), `ssf-bplug-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), RUN_TS);
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\nbravo\n");
  writeFileSync(join(skill, "secrets", "hint.md"), "casual hint\n");
  const keyMaterial = keys();
  const manifest = parseYaml(MANIFEST) as SkillManifest;
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest,
    config: config(),
    keys: {
      rootSecret: keyMaterial.rootSecret,
      rootKid: "prod-2026",
      artifactPrivateKey: keyMaterial.artifactPrivateKey,
      artifactKid: "prod-2026",
      licensePublicKey: keyMaterial.licensePublicKey,
    },
    plugins: extra.plugins,
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_bplug",
  });
  return { ...result, token, keyMaterial };
}

function plugin(name: string, build: SsfPlugin["build"]): SsfPlugin {
  return { name, apiVersion: 1, build };
}

function runNode(outDir: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(process.execPath, [join(outDir, "scripts", "runtime.js"), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 30000,
  });
}

describe("build plugins", () => {
  test("apiVersion mismatch and contract failure reject the build (F-66 rules 4-5)", async () => {
    const stale = { name: "stale", apiVersion: 0, build: {} } as unknown as SsfPlugin;
    await expect(buildFixture({ plugins: [stale] })).rejects.toMatchObject({ name: "BuildError" });
    try {
      await buildFixture({ plugins: [stale] });
      throw new Error("should have failed");
    } catch (error) {
      expect((error as BuildError).stage).toBe("plugins");
      expect((error as Error).message).toContain("apiVersion");
    }
    const breaker = plugin("breaker", {
      transformCompanion: async () => {
        throw new Error("contract probe must fail");
      },
    });
    await expect(buildFixture({ plugins: [breaker] })).rejects.toThrow("contract test");
  }, 180000);

  test("default build runs codec-default through the runner and embeds builtins", async () => {
    const result = await buildFixture();
    expect(result.plugins.plugins).toEqual(["codec-default"]);
    expect(result.plugins.contractTests.length).toBeGreaterThan(0);
    expect(result.plugins.contractTests.every((entry) => entry.passed)).toBe(true);
    expect(result.plugins.embeddedPlugins).toEqual(["license-source-env", "license-source-file"]);
    expect(result.plugins.directApiOnly).toEqual([]);
    expect(result.plugins.transforms.companion).toBe(1);
    expect(result.plugins.transforms.source).toBe(0);
    const runtimeJs = readFileSync(join(result.outDir, "scripts", "runtime.js"), "utf8");
    expect(runtimeJs).toContain("license-source-env");
  }, 120000);

  test("transformSource rewrites entry code before bundling", async () => {
    const banner = plugin("banner", { transformSource: async (_context, code) => code.replaceAll("ORIGINAL", "MODIFIED") });
    const result = await buildFixture({ plugins: [banner] });
    expect(result.plugins.transforms.source).toBeGreaterThan(0);
    const stdout = runNode(result.outDir, ["run", "echo-tag"], { ACME_SSF_LICENSE: result.token });
    expect(stdout).toContain("MODIFIED");
    expect(stdout).not.toContain("ORIGINAL");
  }, 120000);

  test("transformCompanion rewrites protected text and keeps the mode", async () => {
    const marker = plugin("marker", { transformCompanion: async (_context, text) => `${text}[appended]` });
    const result = await buildFixture({ plugins: [marker] });
    const stdout = runNode(result.outDir, ["read", "secrets/notes.md"], { ACME_SSF_LICENSE: result.token });
    expect(stdout).toContain("[appended]");
  }, 120000);

  test("lifecycle stages run in order and issueLicense validates ext-only", async () => {
    const seen: string[] = [];
    const lifecycle = plugin("lifecycle", {
      configResolved: async () => { seen.push("configResolved"); },
      buildStart: async () => { seen.push("buildStart"); },
      buildEnd: async () => { seen.push("buildEnd"); },
      packageReady: async () => { seen.push("packageReady"); },
      issueLicense: async (draft) => ({ ext: { ...draft.ext, tenant: "acme" } }),
    });
    const result = await buildFixture({ plugins: [lifecycle] });
    // Contract tests invoke every hook once with a synthetic context before
    // the real build, so the real pass is the tail of the record.
    expect(seen.slice(-4)).toEqual(["configResolved", "buildStart", "packageReady", "buildEnd"]);
    expect(result.plugins.contractTests.some((entry) => entry.hook === "lifecycle:build.issueLicense" && entry.passed)).toBe(true);
  }, 120000);

  test("bad shape, wrong apiVersion, and failing contracts fail the build", async () => {
    const badApi = { name: "old", apiVersion: 0 } as unknown as SsfPlugin;
    await expect(buildFixture({ plugins: [badApi] })).rejects.toMatchObject({ name: "BuildError", stage: "plugins" });
    const throwing = plugin("throwing", { transformSource: async () => { throw new Error("boom"); } });
    await expect(buildFixture({ plugins: [throwing] })).rejects.toMatchObject({ name: "BuildError", stage: "plugins" });
    try {
      await buildFixture({ plugins: [throwing] });
      throw new Error("should have failed");
    } catch (error) {
      expect((error as BuildError).stage).toBe("plugins");
      expect((error as Error).message).toContain('"throwing"');
    }
  }, 180000);
});
