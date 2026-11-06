// F-82/F-83: real skills.sh CLI interop and install layouts. Builds one
// skill for real (v1 then v2), drives `npx skills add --list`, installs to
// isolated project dirs (copy, manual symlink, space path), and serves the
// installed copies with the matching license token.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateRootSecret, generateSigningKeypair, signArtifact } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { buildSkill } from "@ssf/build";
import { createRuntime, type RuntimeConfig } from "@ssf/runtime";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillManifestText, type SkillManifest, type SsfConfig } from "@ssf/manifest";

const MANIFEST = (version: string): string =>
  [
    "skill:",
    "  id: demo",
    `  version: ${version}`,
    "  description: Demo skill for npx tests. Use when testing installs.",
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
    "    description: Echo back",
    "    usage: <words...>",
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

interface Built {
  version: string;
  distDir: string;
  token: string;
  keyMaterial: ReturnType<typeof keys>;
}

async function buildVersion(root: string, version: string, keyMaterial: ReturnType<typeof keys>): Promise<Built> {
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST(version));
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(skill, "references", "guide.md"), "Guide.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), `notes for ${version}\n`);
  const manifest = parseSkillManifestText(MANIFEST(version));
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
    options: { force: true },
  });
  const { token } = issueLicense({
    rootSecret: keyMaterial.rootSecret,
    licensePrivateKey: keyMaterial.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: `lic_npx_${version}`,
  });
  return { version, distDir: join(root, "dist"), token, keyMaterial };
}

function skills(args: string[], cwd: string): string {
  return execFileSync("npx", ["-y", "skills", ...args], { cwd, encoding: "utf8", timeout: 120000 });
}

function runtimeFor(skillDir: string, built: Built): ReturnType<typeof createRuntime> {
  const containerBytes = readFileSync(join(skillDir, "scripts", "runtime.bin"));
  const { signature } = signArtifact(built.keyMaterial.artifactPrivateKey, containerBytes, "prod-2026");
  const config: RuntimeConfig = {
    skillDir,
    publisher: "acme",
    skillId: "demo",
    version: built.version,
    keys: {
      licensePublicKey: built.keyMaterial.licensePublicKey,
      artifactPublicKey: built.keyMaterial.artifactPublicKey,
      artifactKid: "prod-2026",
      artifactSignature: signature,
    },
    licenseEnvVar: "ACME_SSF_LICENSE",
    licenseConfigDir: join(tmpdir(), `ssf-npx-cfg-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    stateDir: join(tmpdir(), `ssf-npx-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`),
    token: built.token,
  };
  return createRuntime(config);
}

describe("npx skills interop", () => {
  test("add --list finds built skills; install, update, and remove work", async () => {
    const root = join(tmpdir(), `ssf-npx-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const keyMaterial = keys();
    const v1 = await buildVersion(root, "1.0.0", keyMaterial);
    const listed = skills(["add", v1.distDir, "--list", "-y"], root);
    expect(listed).toContain("demo");
    expect(listed).toContain("Found 1 skill");

    const proj = join(root, "proj");
    mkdirSync(proj, { recursive: true });
    skills(["add", v1.distDir, "-s", "demo", "-a", "claude-code", "-y"], proj);
    const installed = join(proj, ".claude", "skills", "demo");
    const served = await runtimeFor(installed, v1).read("secrets/notes.md");
    expect(served.content).toContain("notes for 1.0.0");

    const v2 = await buildVersion(root, "1.0.1", keyMaterial);
    skills(["remove", "-s", "demo", "-a", "claude-code", "-y"], proj);
    skills(["add", v2.distDir, "-s", "demo", "-a", "claude-code", "-y"], proj);
    const served2 = await runtimeFor(join(proj, ".claude", "skills", "demo"), v2).read("secrets/notes.md");
    expect(served2.content).toContain("notes for 1.0.1");
  }, 300000);

  test("symlink, copy, and space-path installs all serve", async () => {
    const root = join(tmpdir(), `ssf-npxlay-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    const keyMaterial = keys();
    const v1 = await buildVersion(root, "1.0.0", keyMaterial);
    const linkDir = join(root, "agents", "skills");
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(v1.distDir, "skills", "demo"), join(linkDir, "demo"));
    const viaLink = await runtimeFor(join(linkDir, "demo"), v1).list();
    expect(viaLink.some((entry) => entry.id === "secrets/notes.md")).toBe(true);

    const spaced = join(root, "my proj", ".agents", "skills", "demo");
    mkdirSync(join(spaced, ".."), { recursive: true });
    skills(["add", v1.distDir, "-s", "demo", "-a", "codex", "-y", "--copy"], join(root, "my proj"));
    expect(readFileSync(join(spaced, "SKILL.md"), "utf8")).toContain("# Demo");
    const viaCopy = await runtimeFor(spaced, v1).run("echo-args", ["hi"]);
    expect(viaCopy.stdout).toContain("hi");
  }, 300000);
});
