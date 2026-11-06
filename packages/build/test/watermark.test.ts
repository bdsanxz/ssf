// F-92: per-license watermark end to end. A real build plus the real
// watermark plugin: protected reads carry a marker tracing the issuing
// license, public files stay unmarked, and leaked text verifies.

import { afterEach, describe, expect, test } from "bun:test";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { buildSkill } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createRuntime, type RuntimeConfig } from "@ssf/runtime";
import { createWatermarkPlugin, extractWatermark, verifyWatermark } from "@ssf/plugins";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for watermark tests. Use when testing leaks.",
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
].join("\n");

const SECRET = ["watermark-test", "secret-32"].join("-");
const ENV_VAR = "SSF_WATERMARK_TEST_LICENSE";

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
  const root = join(tmpdir(), `ssf-wm-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
  const keyMaterial = keys();
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest: parseYaml(MANIFEST) as SkillManifest,
    config: {
      workspace: { publisher: "acme", defaultMode: "offline" },
      license: { env: ENV_VAR, configFile: "acme/license" },
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
    licenseId: "lic_wm_1",
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
    licenseConfigDir: join(tmpdir(), `ssf-wm-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-wm-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    token: fx.token,
    plugins: [createWatermarkPlugin({ secret: SECRET })],
  };
}

afterEach(() => {
  delete process.env[ENV_VAR];
});

describe("per-license watermark (F-92)", () => {
  test("protected reads carry the issuing license marker; leaks verify", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    const page = await runtime.read("secrets/notes.md");
    expect(page.content).toContain("alpha");
    expect(page.content).toContain("[ssf-watermark lic_wm_1:");
    expect(extractWatermark(page.content)).toMatchObject({ licenseId: "lic_wm_1" });
    expect(verifyWatermark(page.content, SECRET, "lic_wm_1")).toBe(true);
  }, 120000);

  test("public files stay unmarked", async () => {
    const fx = await fixture();
    const runtime = createRuntime(baseConfig(fx));
    const page = await runtime.read("references/guide.md");
    expect(page.content).not.toContain("ssf-watermark");
  }, 120000);
});
