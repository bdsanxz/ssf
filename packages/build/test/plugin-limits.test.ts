// F-65: core limits that plugins cannot move. One shared build fixture:
// a tampered container still fails against an allow-all plugin, protection
// modes survive hostile transforms, packageReady stays read-only, and
// unknown hooks never reach the runner.
import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, decodeContainer, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import type { SsfPlugin } from "@ssf/plugin-api";
import { buildSkill, BuildError } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildNotice } from "@ssf/agent-contract";
import { createRuntime, executeCommand, RuntimeError } from "@ssf/runtime";
import { AEAD_ALGORITHM, KEY_SEPARATION } from "@ssf/crypto";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for limit tests. Use when testing core limits.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Internal notes",
  "  - path: secrets/hint.md",
  "    protection: obfuscated",
  "    description: Casual hint",
  "",
  "scripts:",
  "  - id: echo-args",
  "    entry: src/echo.ts",
  "    description: Echo arguments back",
  "    usage: <words...>",
  "",
].join("\n");

const RUN_TS = "const args = process.argv.slice(2);\nconsole.log(JSON.stringify(args));\n";

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
  root: string;
  token: string;
  keyMaterial: ReturnType<typeof keys>;
}

let cached: Fixture | null = null;

async function fixture(plugins?: SsfPlugin[]): Promise<Fixture> {
  if (cached && !plugins) {
    return cached;
  }
  const root = join(tmpdir(), `ssf-lim-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
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
    plugins,
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: "lic_lim",
  });
  const built: Fixture = { outDir: result.outDir, root, token, keyMaterial };
  if (!plugins) {
    cached = built;
  }
  return built;
}

function runtimeFor(fx: Fixture, plugins?: SsfPlugin[], token?: string, configDir?: string) {
  const containerBytes = readFileSync(join(fx.outDir, "scripts", "runtime.bin"));
  const { signature } = signArtifact(fx.keyMaterial.artifactPrivateKey, containerBytes, "prod-2026");
  return createRuntime({
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
    token: token ?? fx.token,
    licenseConfigDir: configDir ?? join(tmpdir(), `ssf-lim-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-lim-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    plugins,
  });
}

function plugin(name: string, build?: SsfPlugin["build"], runtime?: SsfPlugin["runtime"]): SsfPlugin {
  return { name, apiVersion: 1, ...(build ? { build } : {}), ...(runtime ? { runtime } : {}) };
}

describe("core limits", () => {
  test("obfuscated companions decode to agent-facing text on read", async () => {
    const fx = await fixture();
    const page = await runtimeFor(fx).read("secrets/hint.md");
    expect(page.content).toBe("casual hint");
  }, 120000);

  test("tampered container fails even with an allow-all plugin", async () => {
    const fx = await fixture();
    const allowAll = plugin("allow-all", undefined, { verifyLicense: async () => true });
    const bytes = readFileSync(join(fx.outDir, "scripts", "runtime.bin"));
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    writeFileSync(join(fx.outDir, "scripts", "runtime.bin"), tampered);
    try {
      await expect(runtimeFor(fx, [allowAll]).list()).rejects.toMatchObject({ code: "ARTIFACT_INVALID" });
    } finally {
      writeFileSync(join(fx.outDir, "scripts", "runtime.bin"), bytes);
    }
  }, 120000);

  test("hostile transforms cannot downgrade the protection mode", async () => {
    const stripper = plugin("stripper", { transformCompanion: async () => "plain text, no tier-1" });
    const fx = await fixture([stripper]);
    const container = decodeContainer(readFileSync(join(fx.outDir, "scripts", "runtime.bin")));
    const hint = container.entries.find((entry) => entry.id === "secrets/hint.md");
    expect(hint?.protection).toBe("obfuscated");
    // The stripped payload no longer tier-1-decodes: read fails closed.
    await expect(runtimeFor(fx).read("secrets/hint.md")).rejects.toThrow();
  }, 120000);

  test("packageReady mutations and unknown hooks fail the build", async () => {
    const mutating = plugin("mutating", {
      packageReady: async (pkg) => { (pkg as { notices: string[] }).notices.push("pwned"); },
    });
    await expect(fixture([mutating])).rejects.toMatchObject({ name: "BuildError" });
    try {
      await fixture([mutating]);
      throw new Error("should have failed");
    } catch (error) {
      expect((error as BuildError).stage).toBe("plugins");
    }
    const unknown = { name: "weird", apiVersion: 1, build: { encrypt: async () => {} } } as unknown as SsfPlugin;
    await expect(fixture([unknown])).rejects.toMatchObject({ name: "BuildError" });
  }, 180000);
});

describe("issuance checks survive hostile plugins", () => {
  const allowAll = plugin("allow-all", undefined, { verifyLicense: async () => true });

  function customToken(fx: Fixture, overrides: { expiresAt?: number; publisher?: string; tamper?: boolean }): string {
    const { token } = issueLicense({
      rootSecret: fx.keyMaterial.rootSecret,
      licensePrivateKey: fx.keyMaterial.licensePrivateKey,
      licenseKid: "prod-2026",
      publisher: overrides.publisher ?? "acme",
      skills: [{ skillId: "demo", version: "1.0.0" }],
      expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 86400,
      licenseId: "lic_lim_evil",
    });
    if (!overrides.tamper) {
      return token;
    }
    const parts = token.split(".");
    const body = Buffer.from(parts[2]!, "base64url").toString("utf8").replace("demo", "dem0");
    parts[2] = Buffer.from(body, "utf8").toString("base64url");
    return parts.join(".");
  }

  test("expired, tampered, and mis-publisher tokens fail despite allow-all", async () => {
    const fx = await fixture();
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(runtimeFor(fx, [allowAll], customToken(fx, { expiresAt: past })).list()).rejects.toMatchObject({
      code: "LICENSE_EXPIRED",
    });
    await expect(runtimeFor(fx, [allowAll], customToken(fx, { tamper: true })).list()).rejects.toMatchObject({
      code: "LICENSE_INVALID",
    });
    await expect(runtimeFor(fx, [allowAll], customToken(fx, { publisher: "evil" })).list()).rejects.toMatchObject({
      code: "LICENSE_INVALID",
    });
  }, 120000);

  test("deny beats a core allow; hook throw and timeout fail closed", async () => {
    const fx = await fixture();
    const denier = plugin("denier", undefined, {
      verifyLicense: async (context) => {
        context.deny("PLUGIN_DENIED", "No access for this customer.");
      },
    });
    await expect(runtimeFor(fx, [allowAll, denier]).list()).rejects.toMatchObject({ code: "PLUGIN_DENIED" });
    const thrower = plugin("thrower", undefined, {
      verifyLicense: async () => {
        throw new Error("boom");
      },
    });
    await expect(runtimeFor(fx, [thrower]).list()).rejects.toMatchObject({ code: "PLUGIN_ERROR" });
    // Hook timeouts use the same fail-closed path; the runner-level case is
    // pinned in plugin-api/test/runner.test.ts (30s default, 20ms probe).
  }, 120000);

  test("hook contexts carry names and paths, never key material (F-66 rule 6)", async () => {
    const fx = await fixture();
    const seen: unknown[] = [];
    const recorder = plugin("recorder", undefined, {
      loadLicense: async (context) => {
        seen.push({ ...context });
        return null;
      },
      verifyLicense: async (context) => {
        const { deny: _deny, ...rest } = context;
        seen.push({ ...rest, license: { ...context.license } });
      },
      afterRead: async (context, text) => {
        seen.push({ ...context });
        return text;
      },
    });
    // No source answers (blank caller token, fresh config dir, no env var):
    // the read fails closed after loadLicense has seen its context.
    await expect(runtimeFor(fx, [recorder], "").read("secrets/hint.md")).rejects.toMatchObject({
      code: "LICENSE_MISSING",
    });
    expect(seen.length).toBe(1);
    // A seeded config-file source answers: auth succeeds, so the verifier
    // and afterRead contexts are recorded too, then the read serves.
    const dir = join(tmpdir(), `ssf-lim-seed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "license"), `${fx.token}\n`);
    const page = await runtimeFor(fx, [recorder], "", dir).read("secrets/hint.md");
    expect(page.content).toBe("casual hint");
    expect(seen.length).toBe(4);
    const allowed = new Set([
      "publisher",
      "skillId",
      "version",
      "lang",
      "envVar",
      "configFile",
      "configDir",
      "hasProvidedToken",
      "license",
      "fileId",
      "license_id",
      "mode",
      "skills",
      "issued_at",
      "expires_at",
      "ext",
    ]);
    for (const context of seen) {
      for (const key of Object.keys(context as Record<string, unknown>)) {
        expect(allowed.has(key)).toBe(true);
      }
      const text = JSON.stringify(context);
      expect(text).not.toContain(fx.token);
      expect(text).not.toContain("BEGIN");
      expect(text).not.toContain("PRIVATE");
    }
  }, 120000);

  test("run only serves allowlisted script ids, never paths", async () => {
    const fx = await fixture();
    await expect(runtimeFor(fx).run("no-such-script")).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
    await expect(runtimeFor(fx).run("src/echo.ts")).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
    const run = await runtimeFor(fx).run("echo-args", ["hi"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("hi");
  }, 120000);
});

describe("limits bind post-hook content and the notice budget", () => {
  test("afterRead output is still capped and the notice counts in chars", async () => {
    const fx = await fixture();
    const watermark = plugin("watermark", undefined, {
      afterRead: async (_context, text) => `${text}\n${"W".repeat(100_000)}`,
    });
    const runtime = runtimeFor(fx, [watermark]);
    const maxChars = 1000;
    const page = await runtime.read("secrets/hint.md", { maxChars });
    const noticeLen = Array.from(buildNotice("acme")).length + "\n---\n".length;
    expect(Array.from(page.content).length + noticeLen).toBeLessThanOrEqual(maxChars);
    expect(page.truncated).toBe(true);
    // The formatted agent output carries the notice on top of capped content.
    const rendered = await executeCommand(runtime, { name: "read", path: "secrets/hint.md", maxChars } as never, {
      skillId: "demo",
      publisher: "acme",
    });
    expect(rendered.exitCode).toBe(0);
    expect(rendered.text).toContain(buildNotice("acme"));
  }, 120000);

  test("banner transforms cannot corrupt the generated frontmatter", async () => {
    const fx = await fixture();
    const banner = plugin("banner", { transformSource: async (_context, code) => `// banner\n${code}` });
    const bannered = await fixture([banner]);
    const frontmatter = readFileSync(join(bannered.outDir, "SKILL.md"), "utf8");
    expect(fx.outDir).not.toBe(bannered.outDir);
    expect(frontmatter).toContain("name: demo");
    expect(frontmatter).toMatch(/ssf-version: ['"]?1\.0\.0['"]?/);
  }, 180000);

  test("only allowlisted algorithms exist; plugins cannot name one", async () => {
    expect(AEAD_ALGORITHM).toBe("aes-256-gcm");
    expect(Object.values(KEY_SEPARATION).map((entry) => entry.algorithm).sort()).toEqual([
      "ed25519",
      "ed25519",
      "ed25519",
      "hkdf-sha256",
    ]);
    const sneaky = {
      name: "sneaky",
      apiVersion: 1,
      algorithm: "rot13",
      build: { transformSource: async (_context: unknown, code: string) => code },
    } as unknown as SsfPlugin;
    await expect(fixture([sneaky])).rejects.toMatchObject({ name: "BuildError" });
  }, 180000);
});
