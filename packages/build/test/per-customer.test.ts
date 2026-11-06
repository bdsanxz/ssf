// F-93: per-customer builds. The same skill built with two root secrets
// yields two undecryptable-by-the-other cuts in separate layouts with
// separate releases logs; the shared default cut is untouched.

import { describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { buildSkill } from "../src/pipeline.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createRuntime, RuntimeError, type RuntimeConfig } from "@ssf/runtime";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for per-customer tests. Use when testing cuts.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Notes",
  "",
].join("\n");

function keys() {
  const license = generateSigningKeypair();
  const artifact = generateSigningKeypair();
  return {
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

interface Cut {
  outDir: string;
  rootSecret: Buffer;
  token: string;
}

type KeyMaterial = ReturnType<typeof keys>;

async function buildCut(
  dir: string,
  material: KeyMaterial,
  rootSecret: Buffer,
  out: { distSkillsDir?: string; releasesLog?: string },
): Promise<string> {
  const result = await buildSkill({
    workspaceDir: dir,
    skillDir: join("skills", "demo"),
    manifest: parseYaml(MANIFEST) as SkillManifest,
    config: config(),
    keys: {
      rootSecret,
      rootKid: "prod-2026",
      artifactPrivateKey: material.artifactPrivateKey,
      artifactKid: "prod-2026",
      licensePublicKey: material.licensePublicKey,
    },
    options: { ...out },
  });
  return result.outDir;
}

function runtimeFor(outDir: string, material: KeyMaterial, token: string): ReturnType<typeof createRuntime> {
  const containerBytes = readFileSync(join(outDir, "scripts", "runtime.bin"));
  const { signature } = signArtifact(material.artifactPrivateKey, containerBytes, "prod-2026");
  const cfg: RuntimeConfig = {
    skillDir: outDir,
    publisher: "acme",
    skillId: "demo",
    version: "1.0.0",
    keys: {
      licensePublicKey: material.licensePublicKey,
      artifactPublicKey: material.artifactPublicKey,
      artifactKid: "prod-2026",
      artifactSignature: signature,
    },
    licenseEnvVar: "ACME_SSF_LICENSE",
    licenseConfigDir: join(tmpdir(), `ssf-pccfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-pcstate-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    token,
  };
  return createRuntime(cfg);
}

function tokenFor(material: KeyMaterial, rootSecret: Buffer, customer?: string): string {
  const { token } = issueLicense({
    rootSecret,
    licensePrivateKey: material.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    customer,
    licenseId: `lic_${customer ?? "default"}`,
  });
  return token;
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

describe("per-customer builds (F-93)", () => {
  test("customer cut decrypts only with the customer token", async () => {
    const dir = join(tmpdir(), `ssf-pc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const skill = join(dir, "skills", "demo");
    mkdirSync(join(skill, "secrets"), { recursive: true });
    writeFileSync(join(skill, "skill.manifest"), MANIFEST);
    writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
    writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
    const material = keys();
    const defaultSecret = generateRootSecret();
    const customerSecret = generateRootSecret();
    const defaultOut = await buildCut(dir, material, defaultSecret, {});
    const customerOut = await buildCut(dir, material, customerSecret, {
      distSkillsDir: join("dist", "customers", "acme-corp", "skills"),
      releasesLog: join("dist", "customers", "acme-corp", "releases.jsonl"),
    });
    expect(customerOut).toContain(join("customers", "acme-corp"));
    expect(existsSync(join(dir, "releases.jsonl"))).toBe(true);
    expect(existsSync(join(dir, "dist", "customers", "acme-corp", "releases.jsonl"))).toBe(true);
    const defaultBin = readFileSync(join(defaultOut, "scripts", "runtime.bin"));
    const customerBin = readFileSync(join(customerOut, "scripts", "runtime.bin"));
    expect(Buffer.compare(defaultBin, customerBin)).not.toBe(0);
    // Tokens must be issued with the matching root secret (same customer label).
    const defaultToken = tokenFor(material, defaultSecret);
    const customerToken = tokenFor(material, customerSecret, "acme-corp");
    const customerRead = await runtimeFor(customerOut, material, customerToken).read("secrets/notes.md");
    expect(customerRead.content).toContain("alpha");
    const defaultRead = await runtimeFor(defaultOut, material, defaultToken).read("secrets/notes.md");
    expect(defaultRead.content).toContain("alpha");
    await expectCode(runtimeFor(customerOut, material, defaultToken).read("secrets/notes.md"), "ARTIFACT_INVALID");
    await expectCode(runtimeFor(defaultOut, material, customerToken).read("secrets/notes.md"), "ARTIFACT_INVALID");
  }, 180000);
});
