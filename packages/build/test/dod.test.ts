// F-91: Definition-of-Done adversarial gaps. One shared build fixture:
// traversal attempts, path-shaped script ids, no script source in any UI
// output, cross-skill scope, and dev/example kid rejection at the runtime.
import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { buildSkill } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createRuntime, RuntimeError, type RuntimeConfig } from "@ssf/runtime";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for DoD tests. Use when testing guarantees.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: references/guide.md",
  "    protection: none",
  "    description: Guide",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Notes",
  "",
  "scripts:",
  "  - id: echo-args",
  "    entry: src/echo.ts",
  "    description: Echo arguments back",
  "    usage: <words...>",
  "    max_output_chars: 30",
  "    timeout_seconds: 2",
  "",
].join("\n");

const SOURCE = "const SECRET_MARKER = \"dod-source-secret\";\nconst args = process.argv.slice(2);\nif (args[0] === \"hang-forever\") { while (true) {} }\nconsole.log(JSON.stringify(args));\n";

const MANIFEST2 = [
  "skill:",
  "  id: demo2",
  "  version: 1.0.0",
  "  description: Second demo skill for scope tests. Use when testing multi-skill tokens.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: secrets/notes2.md",
  "    protection: encrypted",
  "    description: Notes two",
  "",
].join("\n");

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

interface Fixture {
  outDir: string;
  outDir2: string;
  token: string;
  keyMaterial: ReturnType<typeof keys>;
}

let cached: Fixture | null = null;

async function fixture(): Promise<Fixture> {
  if (cached) {
    return cached;
  }
  const root = join(tmpdir(), `ssf-dod-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), SOURCE);
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
  const skill2 = join(root, "skills", "demo2");
  mkdirSync(join(skill2, "secrets"), { recursive: true });
  writeFileSync(join(skill2, "skill.manifest"), MANIFEST2);
  writeFileSync(join(skill2, "SKILL.md"), "# Demo Two\n\nAuthor text.\n");
  writeFileSync(join(skill2, "secrets", "notes2.md"), "beta\n");
  const keyMaterial = keys();
  const buildKeys = {
    rootSecret: keyMaterial.rootSecret,
    rootKid: "prod-2026",
    artifactPrivateKey: keyMaterial.artifactPrivateKey,
    artifactKid: "prod-2026",
    licensePublicKey: keyMaterial.licensePublicKey,
  };
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest: parseYaml(MANIFEST) as SkillManifest,
    config: config(),
    keys: buildKeys,
  });
  const result2 = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo2"),
    manifest: parseYaml(MANIFEST2) as SkillManifest,
    config: config(),
    keys: buildKeys,
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [
      { skillId: "demo", version: "1.0.0" },
      { skillId: "demo2", version: "1.0.0" },
    ],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_dod",
  });
  cached = { outDir: result.outDir, outDir2: result2.outDir, token, keyMaterial };
  return cached;
}

function baseConfig(fx: Fixture, overrides: Partial<RuntimeConfig> = {}, outDir: string = fx.outDir): RuntimeConfig {
  const containerBytes = readFileSync(join(outDir, "scripts", "runtime.bin"));
  const { signature } = signArtifact(fx.keyMaterial.artifactPrivateKey, containerBytes, "prod-2026");
  return {
    skillDir: outDir,
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
    licenseConfigDir: join(tmpdir(), `ssf-dod-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-dod-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    token: fx.token,
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: RuntimeError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} but the call succeeded.`);
}

describe("definition of done", () => {
  test("traversal and absolute paths fail closed", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    await expectCode(runtime.read("../skill.manifest"), "PATH_NOT_FOUND");
    await expectCode(runtime.read("/etc/passwd"), "PATH_NOT_FOUND");
    await expectCode(runtime.read("references/../../skill.manifest"), "PATH_NOT_FOUND");
    await expectCode(runtime.search("../", "alpha"), "PATH_NOT_FOUND");
  }, 120000);

  test("backslash paths are normalized; traversal still fails", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    // F-86: Windows separators convert to logical slashes before lookup.
    expect((await runtime.read("secrets\\notes.md")).content).toBe("alpha");
    expect((await runtime.read("references\\guide.md")).content).toBe("Guide.");
    expect((await runtime.list("secrets\\")).some((entry) => entry.id === "secrets/notes.md")).toBe(true);
    const hits = await runtime.search("secrets\\", "alpha");
    expect(hits.some((hit) => hit.path === "secrets/notes.md")).toBe(true);
    // Normalization never opens traversal: backslash .. becomes ../ and fails.
    await expectCode(runtime.read("..\\skill.manifest"), "PATH_NOT_FOUND");
    await expectCode(runtime.read("..\\secrets\\notes.md"), "PATH_NOT_FOUND");
    await expectCode(runtime.read("secrets\\..\\skill.manifest"), "PATH_NOT_FOUND");
    await expectCode(runtime.run("src\\echo.ts"), "PATH_NOT_FOUND");
  }, 120000);

  test("path-shaped script ids never execute", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    await expectCode(runtime.run("echo-args/../x"), "PATH_NOT_FOUND");
    await expectCode(runtime.run("../echo-args"), "PATH_NOT_FOUND");
    await expectCode(runtime.run("references/guide.md"), "PATH_NOT_FOUND");
  }, 120000);

  test("no interface surfaces script source", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    for (const entry of await runtime.list()) {
      expect(JSON.stringify(entry)).not.toContain("dod-source-secret");
    }
    for (const hit of await runtime.search("", "echo")) {
      expect(hit.snippet).not.toContain("dod-source-secret");
    }
    const run = await runtime.run("echo-args", ["hi"]);
    expect(run.stdout).not.toContain("dod-source-secret");
  }, 120000);

  test("a token for one skill does not open another", async () => {
    const fx = await fixture();
    await expectCode(createRuntime(baseConfig(fx, { skillId: "other" })).list(), "LICENSE_SCOPE");
  }, 120000);

  test("one token opens every skill in scope", async () => {
    const fx = await fixture();
    const first = await createRuntime(baseConfig(fx)).read("secrets/notes.md");
    expect(first.content).toBe("alpha");
    const second = await createRuntime(baseConfig(fx, { skillId: "demo2" }, fx.outDir2)).read("secrets/notes2.md");
    expect(second.content).toBe("beta");
  }, 120000);

  test("run output is capped and hangs time out", async () => {
    const fx = await fixture();
    // Caps are baked per script entry at build time (manifest entry wins,
    // workspace limits are the fallback): 30 chars, 2 seconds here.
    const small = await createRuntime(baseConfig(fx)).run("echo-args", ["x".repeat(500)]);
    expect(small.truncated).toBe(true);
    expect(Array.from(small.stdout).length).toBeLessThanOrEqual(30);
    await expectCode(createRuntime(baseConfig(fx)).run("echo-args", ["hang-forever"]), "SCRIPT_TIMEOUT");
  }, 120000);

  test("error text never echoes the credential", async () => {
    const fx = await fixture();
    const parts = fx.token.split(".");
    parts[2] = Buffer.from(
      Buffer.from(parts[2]!, "base64url").toString("utf8").replace("demo", "dem0"),
      "utf8",
    ).toString("base64url");
    const badToken = parts.join(".");
    const runtime = createRuntime(baseConfig(fx, { token: badToken }));
    const failure = await runtime.list().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RuntimeError);
    const rendered = runtime.formatError(failure);
    expect(rendered.text).not.toContain(badToken);
    expect(rendered.text).not.toContain("BEGIN");
    expect(rendered.text).toContain("ERROR LICENSE_INVALID");
  }, 120000);

  test("dev and example kids are rejected in production", async () => {
    const fx = await fixture();
    for (const kid of ["dev", "example"]) {
      const kp = generateSigningKeypair();
      const { token } = issueLicense({
        rootSecret: fx.keyMaterial.rootSecret,
        licensePrivateKey: kp.privateKey,
        licenseKid: kid,
        publisher: "acme",
        skills: [{ skillId: "demo", version: "1.0.0" }],
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        licenseId: `lic_${kid}`,
      });
      const error = await createRuntime(baseConfig(fx, { token })).list().then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("LICENSE_DEV_KEY");
    }
  }, 120000);
});
