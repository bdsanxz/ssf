// F-45 through F-56 integration: real build, real license, real runtime.
// Exercises list/read/search/run, fail-closed flow, spread checks, public
// access, pagination, and state — plus license error mapping.

import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { buildSkill } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createRuntime, type RuntimeConfig } from "@ssf/runtime";
import { RuntimeError } from "@ssf/runtime";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for runtime tests. Use when testing access.",
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
  "    max_lines: 3",
  "",
  "scripts:",
  "  - id: echo-args",
  "    entry: src/echo.ts",
  "    description: Echo arguments back",
  "    usage: <words...>",
  "  - id: hang",
  "    entry: src/hang.ts",
  "    description: Hangs forever",
  "    usage: nothing",
  "    timeout_seconds: 1",
  "",
].join("\n");

const RUN_TS = "const args = process.argv.slice(2);\nconsole.log(JSON.stringify(args));\n";
const HANG_TS = "while (true) {}\n";

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

interface Fixture {
  outDir: string;
  token: string;
  keyMaterial: ReturnType<typeof keys>;
  stateDir: string;
}

async function fixture(): Promise<Fixture> {
  const root = join(tmpdir(), `ssf-rt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), RUN_TS);
  writeFileSync(join(skill, "src", "hang.ts"), HANG_TS);
  writeFileSync(join(skill, "references", "public.md"), "Public guide line one.\nPublic guide line two.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\nbravo\ncharlie\ndelta\necho\n");
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
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_rt",
  });
  return { outDir: result.outDir, token, keyMaterial, stateDir: join(tmpdir(), `ssf-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`) };
}

function baseConfig(fx: Fixture): Omit<RuntimeConfig, "token" | "stateDir"> & { token?: string; stateDir?: string } {
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
    licenseEnvVar: "ACME_SSF_LICENSE",
  };
}

async function expectCode(promise: Promise<unknown>, code: RuntimeError["code"]): Promise<RuntimeError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe(code);
    return error as RuntimeError;
  }
  throw new Error(`Expected ${code} but the call succeeded.`);
}

describe("runtime integration", () => {
  test("lists public files without a license and everything with one", async () => {
    const fx = await fixture();
    const anon = createRuntime({ ...baseConfig(fx), stateDir: join(fx.stateDir, "anon") });
    const publicOnly = await anon.list();
    expect(publicOnly.every((entry) => entry.visibility === "public")).toBe(true);
    expect(publicOnly.some((entry) => entry.id === "references/public.md")).toBe(true);
    const authed = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "authed") });
    const all = await authed.list();
    expect(all.some((entry) => entry.id === "secrets/notes.md" && entry.visibility === "protected")).toBe(true);
    expect(all.some((entry) => entry.kind === "script" && entry.id === "echo-args")).toBe(true);
    const filtered = await authed.list("references/");
    expect(filtered.some((entry) => entry.id === "references/public.md")).toBe(true);
    expect(filtered.every((entry) => entry.kind === "file" && entry.id.startsWith("references/"))).toBe(true);
    expect(filtered.some((entry) => entry.id === "secrets/notes.md")).toBe(false);
  }, 120000);

  test("reads public files freely and protected files with pagination", async () => {
    const fx = await fixture();
    const anon = createRuntime({ ...baseConfig(fx), stateDir: join(fx.stateDir, "anon") });
    const pub = await anon.read("references/public.md");
    expect(pub.content).toContain("Public guide line one.");
    expect(pub.isProtected).toBe(false);
    await expectCode(anon.read("secrets/notes.md"), "LICENSE_MISSING");
    const authed = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "authed") });
    const page = await authed.read("secrets/notes.md", { start: 1, limit: 2 });
    expect(page.content).toBe("alpha\nbravo");
    expect(page.totalLines).toBe(5);
    expect(page.nextStart).toBe(3);
    expect(page.isProtected).toBe(true);
    const capped = await authed.read("secrets/notes.md");
    expect(capped.content).toBe("alpha\nbravo\ncharlie");
    expect(capped.nextStart).toBe(4);
    await expectCode(authed.read("echo-args"), "NOT_READABLE");
    await expectCode(authed.read("nope.md"), "PATH_NOT_FOUND");
  }, 120000);

  test("searches public and protected content and rejects script ids", async () => {
    const fx = await fixture();
    const anon = createRuntime({ ...baseConfig(fx), stateDir: join(fx.stateDir, "anon") });
    const pub = await anon.search("references/", "guide");
    expect(pub.length).toBeGreaterThan(0);
    expect(pub.every((result) => result.isProtected === false)).toBe(true);
    const authed = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "authed") });
    const found = await authed.search("secrets/", "charlie");
    expect(found.length).toBe(1);
    expect(found[0]?.path).toBe("secrets/notes.md");
    expect(found[0]?.line).toBe(3);
    expect(found[0]?.isProtected).toBe(true);
    await expectCode(authed.search("echo-args", "x"), "NOT_READABLE");
    await expectCode(authed.search("missing/", "x"), "PATH_NOT_FOUND");
  }, 120000);

  test("runs registered scripts from memory and times out hangs", async () => {
    const fx = await fixture();
    const authed = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "authed") });
    const result = await authed.run("echo-args", ["hello", "world"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["hello", "world"]);
    await expectCode(authed.run("hang", []), "SCRIPT_TIMEOUT");
    await expectCode(authed.run("missing", []), "PATH_NOT_FOUND");
    const anon = createRuntime({ ...baseConfig(fx), stateDir: join(fx.stateDir, "anon") });
    await expectCode(anon.run("echo-args", []), "LICENSE_MISSING");
  }, 120000);

  test("maps invalid, expired, and tampered credentials", async () => {
    const fx = await fixture();
    const badKey = generateSigningKeypair();
    const wrongKey = createRuntime({
      ...baseConfig(fx),
      token: fx.token,
      stateDir: join(fx.stateDir, "wrong"),
      keys: { ...baseConfig(fx).keys, licensePublicKey: badKey.publicKey },
    });
    await expectCode(wrongKey.list("references/"), "LICENSE_INVALID");
    const expired = issueLicense({
      rootSecret: fx.keyMaterial.rootSecret,
      licensePrivateKey: fx.keyMaterial.licensePrivateKey,
      licenseKid: "prod-2026",
      publisher: "acme",
      skills: [{ skillId: "demo", version: "1.0.0" }],
      expiresAt: 1,
    });
    const old = createRuntime({ ...baseConfig(fx), token: expired.token, stateDir: join(fx.stateDir, "old") });
    await expectCode(old.list(), "LICENSE_EXPIRED");
    const tamperedDir = join(tmpdir(), `ssf-tamper-${Date.now()}`);
    cpSync(fx.outDir, tamperedDir, { recursive: true });
    const binPath = join(tamperedDir, "scripts", "runtime.bin");
    const bytes = readFileSync(binPath);
    const last = bytes.length - 1;
    bytes[last] = (bytes[last] ?? 0) ^ 0x01;
    writeFileSync(binPath, bytes);
    const tampered = createRuntime({ ...baseConfig(fx), skillDir: tamperedDir, token: fx.token, stateDir: join(fx.stateDir, "tamper") });
    await expectCode(tampered.list(), "ARTIFACT_INVALID");
  }, 120000);

  test("keeps no cached authorization between instances (F-26)", async () => {
    const fx = await fixture();
    const authed = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "a") });
    await authed.read("secrets/notes.md");
    const anon = createRuntime({ ...baseConfig(fx), stateDir: join(fx.stateDir, "b") });
    await expectCode(anon.read("secrets/notes.md"), "LICENSE_MISSING");
    await expectCode(anon.run("echo-args", []), "LICENSE_MISSING");
    expect(existsSync(join(fx.stateDir, "a"))).toBe(true);
  }, 120000);

  test("reports access state without caching authorization", async () => {
    const fx = await fixture();
    const authed = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "ca") });
    const anon = createRuntime({ ...baseConfig(fx), stateDir: join(fx.stateDir, "cb") });
    expect(await authed.checkAccess()).toEqual({ licensed: true });
    expect(await anon.checkAccess()).toEqual({ licensed: false });
  }, 120000);

  test("records last_seen and reports clock rollback", async () => {
    const fx = await fixture();
    let rolledBack = false;
    const authed = createRuntime({
      ...baseConfig(fx),
      token: fx.token,
      stateDir: join(fx.stateDir, "clock"),
      onClockRollback: () => {
        rolledBack = true;
      },
    });
    await authed.list();
    expect(existsSync(join(fx.stateDir, "clock", "last_seen"))).toBe(true);
    const past = createRuntime({ ...baseConfig(fx), token: fx.token, stateDir: join(fx.stateDir, "clock"), nowSeconds: 1, onClockRollback: () => { rolledBack = true; } });
    await past.list();
    expect(rolledBack).toBe(true);
  }, 120000);
});
