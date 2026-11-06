// F-63: runtime hooks through the SkillRuntime (loadLicense, verifyLicense,
// provideKey rounds, afterRead). Real build, real license, custom plugins as
// in-process objects; every default still flows through the hook runner.
import { afterEach, describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import type { SsfPlugin } from "@ssf/plugin-api";
import { buildSkill } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createRuntime, RuntimeError, type RuntimeConfig } from "@ssf/runtime";
import type { SkillManifest } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for plugin tests. Use when testing hooks.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
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
  "  - id: echo-args",
  "    entry: src/echo.ts",
  "    description: Echo arguments back",
  "    usage: <words...>",
  "",
].join("\n");

const RUN_TS = "const args = process.argv.slice(2);\nconsole.log(JSON.stringify(args));\n";
const ENV_VAR = "SSF_PLUGIN_HOOK_LICENSE";

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

interface Fixture {
  outDir: string;
  token: string;
  keyMaterial: ReturnType<typeof keys>;
}

async function fixture(): Promise<Fixture> {
  const root = join(tmpdir(), `ssf-plug-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), RUN_TS);
  writeFileSync(join(skill, "references", "public.md"), "Public guide.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\nbravo\n");
  const keyMaterial = keys();
  const manifest = parseYaml(MANIFEST) as SkillManifest;
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest,
    config: {
      workspace: { publisher: "acme", defaultMode: "offline" },
      license: { env: ENV_VAR, configFile: "acme/license" },
      keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
      limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
      agent: { confidentialityNotice: { enabled: true } },
      build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
      skills: ["skills/demo"],
      plugins: [],
    },
    keys: {
      rootSecret: keyMaterial.rootSecret,
      rootKid: "prod-2026",
      artifactPrivateKey: keyMaterial.artifactPrivateKey,
      artifactKid: "prod-2026",
      licensePublicKey: keyMaterial.licensePublicKey,
    },
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_plugin",
  });
  return { outDir: result.outDir, token, keyMaterial };
}

function baseConfig(fx: Fixture): RuntimeConfig {
  const containerBytes = readFileSync(join(fx.outDir, "scripts", "runtime.bin"));
  const { signature } = signArtifact(fx.keyMaterial.artifactPrivateKey, containerBytes, "prod-2026");
  return {
    skillDir: fx.outDir,
    publisher: "acme",
    skillId: "demo",
    version: "1.0.0",
    keys: {
      licensePublicKey: fx.keyMaterial.licensePublicKey,
      artifactPublicKey: fx.keyMaterial.artifactPublicKey,
      artifactKid: "prod-2026",
      artifactSignature: signature,
    },
    licenseEnvVar: ENV_VAR,
    licenseConfigDir: join(tmpdir(), `ssf-plug-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-plug-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
  };
}

afterEach(() => {
  delete process.env[ENV_VAR];
});

function plugin(name: string, hooks: SsfPlugin["runtime"]): SsfPlugin {
  return { name, apiVersion: 1, runtime: hooks };
}

describe("runtime hooks", () => {
  test("explicit token still wins over the env builtin (token-first)", async () => {
    const fx = await fixture();
    process.env[ENV_VAR] = "bogus-token";
    const runtime = createRuntime({ ...baseConfig(fx), token: fx.token });
    const entries = await runtime.list();
    expect(entries.some((entry) => entry.id === "secrets/notes.md")).toBe(true);
  }, 120000);

  test("custom loadLicense source licenses without env or caller token", async () => {
    const fx = await fixture();
    const loader = plugin("keychain", { loadLicense: async () => fx.token });
    const runtime = createRuntime({ ...baseConfig(fx), plugins: [loader] });
    const entries = await runtime.list();
    expect(entries.some((entry) => entry.id === "secrets/notes.md")).toBe(true);
  }, 120000);

  test("custom provideKey fills in when builtins come up empty", async () => {
    const fx = await fixture();
    const provider = plugin("sso", { provideKey: async () => fx.token });
    const runtime = createRuntime({ ...baseConfig(fx), plugins: [provider] });
    const page = await runtime.read("secrets/notes.md");
    expect(page.content).toBe("alpha\nbravo");
  }, 120000);

  test("verifyLicense deny carries the denied code and message", async () => {
    const fx = await fixture();
    const tenant = plugin("tenant-check", {
      verifyLicense: async (context) => context.deny("LICENSE_SCOPE", "Tenant mismatch"),
    });
    const runtime = createRuntime({ ...baseConfig(fx), token: fx.token, plugins: [tenant] });
    const failure = await runtime.list().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    expect((failure as RuntimeError).code).toBe("LICENSE_SCOPE");
    expect((failure as RuntimeError).message).toContain("Tenant mismatch");
    const soft = plugin("soft", { verifyLicense: async () => false });
    const softRuntime = createRuntime({ ...baseConfig(fx), token: fx.token, plugins: [soft] });
    const softFailure = await softRuntime.list().then(
      () => null,
      (error: unknown) => error,
    );
    expect(softFailure).toMatchObject({ code: "PLUGIN_DENIED", exitCode: 6 });
  }, 120000);

  test("verifyLicense sees issuance facts but never content keys", async () => {
    const fx = await fixture();
    let seen: Record<string, unknown> | null = null;
    const spy = plugin("spy", {
      verifyLicense: async (context) => {
        seen = context.license as unknown as Record<string, unknown> | null;
      },
    });
    const runtime = createRuntime({ ...baseConfig(fx), token: fx.token, plugins: [spy] });
    await runtime.list();
    expect(seen).not.toBeNull();
    expect(seen).not.toHaveProperty("content_keys");
    expect(seen).toMatchObject({ publisher: "acme" });
    expect(Array.isArray(seen!["skills"])).toBe(true);
  }, 120000);

  test("afterRead transforms protected text only: never public files or scripts", async () => {
    const fx = await fixture();
    const marker = plugin("watermark", { afterRead: async (_context, text) => `${text}\n[via watermark]` });
    const runtime = createRuntime({ ...baseConfig(fx), token: fx.token, plugins: [marker] });
    const page = await runtime.read("secrets/notes.md");
    expect(page.content).toContain("[via watermark]");
    const hits = await runtime.search("", "alpha");
    expect(hits.some((hit) => hit.isProtected && hit.snippet.includes("[via watermark]"))).toBe(true);
    const pub = await runtime.read("references/public.md");
    expect(pub.content).not.toContain("[via watermark]");
    const run = await runtime.run("echo-args", ["hi"]);
    expect(run.stdout).not.toContain("[via watermark]");
  }, 120000);

  test("enforce orders pre before post; apply filters dev-only plugins in prod", async () => {
    const fx = await fixture();
    const first = plugin("first", { afterRead: async (_context, text) => `${text}+pre` });
    first.enforce = "pre";
    const last = plugin("last", { afterRead: async (_context, text) => `${text}+post` });
    last.enforce = "post";
    const runtime = createRuntime({ ...baseConfig(fx), token: fx.token, plugins: [last, first] });
    const page = await runtime.read("secrets/notes.md");
    expect(page.content.endsWith("+pre+post")).toBe(true);

    const devOnly = plugin("dev-keys", { provideKey: async () => fx.token });
    devOnly.apply = "dev";
    const prod = createRuntime({ ...baseConfig(fx), plugins: [devOnly] });
    expect((await prod.list()).some((entry) => entry.id === "secrets/notes.md")).toBe(false);
    const dev = createRuntime({ ...baseConfig(fx), dev: true, plugins: [devOnly] });
    expect((await dev.list()).some((entry) => entry.id === "secrets/notes.md")).toBe(true);
  }, 120000);
});
