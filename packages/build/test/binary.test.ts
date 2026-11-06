// F-94: protected binary assets plus the extract command. A real build
// seals binary bytes (encrypted and obfuscated tiers); read and search
// refuse them as text, and extract writes back byte-identical content.

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
  "  description: Demo skill for binary tests. Use when testing assets.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: references/guide.md",
  "    protection: none",
  "    description: Guide",
  "  - path: assets/logo.png",
  "    protection: encrypted",
  "    description: Logo",
  "  - path: assets/noise.bin",
  "    protection: obfuscated",
  "    description: Noise",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Notes",
  "",
].join("\n");

// Deliberately non-UTF8 bytes (PNG magic plus high bytes).
const LOGO = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01]);
const NOISE = Buffer.from([0x00, 0x01, 0x02, 0x80, 0x81, 0xff, 0xfe, 0xfd]);

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
  const root = join(tmpdir(), `ssf-bin-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "assets"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  writeFileSync(join(skill, "assets", "logo.png"), LOGO);
  writeFileSync(join(skill, "assets", "noise.bin"), NOISE);
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
  const keyMaterial = keys();
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest: parseYaml(MANIFEST) as SkillManifest,
    config: {
      workspace: { publisher: "acme", defaultMode: "offline" },
      license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
      keys: { dir: "./keys", licenseKid: "prod-2026", artifactKid: "prod-2026", rootKid: "prod-2026" },
      limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
      agent: { confidentialityNotice: { enabled: true } },
      build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
      skills: ["skills/demo"],
      plugins: [],
    } satisfies SsfConfig,
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
    licenseId: "lic_bin",
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
    licenseEnvVar: "ACME_SSF_LICENSE",
    licenseConfigDir: join(tmpdir(), `ssf-bin-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-bin-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    token: fx.token,
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

describe("binary assets + extract (F-94)", () => {
  test("extracts byte-identical content for both protected tiers", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    const logoOut = join(tmpdir(), `ssf-logo-${Date.now()}.png`);
    const noiseOut = join(tmpdir(), `ssf-noise-${Date.now()}.bin`);
    const logo = await runtime.extract("assets/logo.png", { outFile: logoOut });
    expect(logo.bytes).toBe(LOGO.length);
    expect(readFileSync(logoOut).equals(LOGO)).toBe(true);
    const noise = await runtime.extract("assets/noise.bin", { outFile: noiseOut });
    expect(readFileSync(noiseOut).equals(NOISE)).toBe(true);
    const listed = await runtime.list("assets");
    expect(listed.some((entry) => entry.id === "assets/logo.png")).toBe(true);
  }, 180000);

  test("read and search refuse binaries; extract refuses text and scripts", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    await expectCode(runtime.read("assets/logo.png"), "NOT_READABLE");
    await expectCode(runtime.search("assets/logo.png", "PNG"), "NOT_READABLE");
    const broad = await runtime.search("", "alpha");
    expect(broad.some((hit) => hit.path === "assets/logo.png")).toBe(false);
    expect(broad.some((hit) => hit.path === "secrets/notes.md")).toBe(true);
    await expectCode(
      runtime.extract("secrets/notes.md", { outFile: join(tmpdir(), `ssf-nope-${Date.now()}.md`) }),
      "NOT_READABLE",
    );
    await expectCode(runtime.extract("references/guide.md", { outFile: join(tmpdir(), "x") }), "NOT_READABLE");
    await expectCode(runtime.extract("assets/missing.png", { outFile: join(tmpdir(), "x") }), "PATH_NOT_FOUND");
  }, 180000);
});
