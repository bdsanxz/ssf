// F-47 tests: the installed scripts/runtime.js entry point.
// Builds a real package with the pipeline, then executes the bundled
// runtime with node from another working directory.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { generateRootSecret, generateSigningKeypair } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { createPublicKey } from "node:crypto";
import { loadContainer, verifyArtifactBeforeDecrypt } from "@ssf/runtime";
import { buildSkill } from "../src/pipeline.js";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for installed-runtime tests. Use when testing installs.",
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

interface Built {
  outDir: string;
  token: string;
  artifactPublicKey: ReturnType<typeof generateSigningKeypair>["publicKey"];
}

async function buildFixture(): Promise<Built> {
  const root = join(tmpdir(), `ssf-inst-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "references"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(skill, "references", "public.md"), "Public guide text.\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "Installed secret notes.\n");
  const license = generateSigningKeypair();
  const artifact = generateSigningKeypair();
  const rootSecret = generateRootSecret();
  const manifest = parseYaml(MANIFEST) as SkillManifest;
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest,
    config: config(),
    keys: {
      rootSecret,
      rootKid: "prod-2026",
      artifactPrivateKey: artifact.privateKey,
      artifactKid: "prod-2026",
      licensePublicKey: license.publicKey,
    },
  });
  const { token } = issueLicense({
    rootSecret,
    licensePrivateKey: license.privateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
  });
  return { outDir: result.outDir, token, artifactPublicKey: artifact.publicKey };
}

function runNode(outDir: string, args: string[], env: NodeJS.ProcessEnv = {}): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync(process.execPath, [join(outDir, "scripts", "runtime.js"), ...args], {
      cwd: tmpdir(),
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 30000,
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: (err.stdout ?? "").toString(), exitCode: err.status ?? 1 };
  }
}

describe("installed runtime.js", () => {
  test("serves public files without a license and everything with one", async () => {
    const { outDir, token } = await buildFixture();
    const anon = runNode(outDir, ["list"]);
    expect(anon.exitCode).toBe(0);
    expect(anon.stdout).toContain("references/");
    expect(anon.stdout).toContain("public.md");
    expect(anon.stdout).not.toContain("secrets/notes.md");
    expect(anon.stdout).toContain("need a license");
    const authed = runNode(outDir, ["list"], { ACME_SSF_LICENSE: token });
    expect(authed.exitCode).toBe(0);
    expect(authed.stdout).toContain("notes.md");
    expect(authed.stdout).toContain("echo-args");
  }, 120000);

  test("runtime hooks ship bundled and signed, with no dynamic loading", async () => {
    const { outDir, token, artifactPublicKey } = await buildFixture();
    const runtimeJs = readFileSync(join(outDir, "scripts", "runtime.js"), "utf8");
    // Builtin hook implementations are bundled in: the embedded names and
    // hook code travel inside runtime.js, not behind a runtime require.
    expect(runtimeJs).toContain("license-source-env");
    expect(runtimeJs).toContain("license-source-file");
    // No dynamic loading from user-writable paths: the shipped entry point
    // (the exact file esbuild bundles) has no dynamic import() and no
    // require() call, so the static bundle cannot pull code from anywhere
    // outside itself and Node builtins at runtime. String literals such as
    // the word "import" inside the obfuscated string table are ignored by
    // stripping strings and comments first.
    const { createRequire } = await import("node:module");
    const entryFile = createRequire(import.meta.url).resolve("@ssf/runtime/src/installed.ts");
    const entrySource = readFileSync(entryFile, "utf8")
      .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(entrySource).not.toMatch(/\bimport\s*\(/);
    expect(entrySource).not.toMatch(/\brequire\s*\(/);
    // The bundle carries the artifact signature, and that exact signature
    // authenticates the shipped container: hooks and content are one unit.
    const embedded = runtimeJs.match(/[0-9a-f]{128}/g) ?? [];
    const container = loadContainer(join(outDir, "scripts", "runtime.bin"));
    const verified = embedded.some((hex) => {
      try {
        verifyArtifactBeforeDecrypt(artifactPublicKey, container, Buffer.from(hex, "hex"));
        return true;
      } catch {
        return false;
      }
    });
    expect(verified).toBe(true);
    // Self-containment: relocate the installed package away, delete the
    // whole source workspace, and run from the copy. The skill serves
    // from its own directory alone.
    // outDir is <root>/dist/skills/<id>, so three levels up is the root.
    const { cpSync, mkdtempSync } = await import("node:fs");
    const relocated = join(mkdtempSync(join(tmpdir(), "ssf-inst-reloc-")), "demo");
    cpSync(outDir, relocated, { recursive: true });
    const workspaceRoot = dirname(dirname(dirname(outDir)));
    rmSync(workspaceRoot, { recursive: true, force: true });
    const authed = runNode(relocated, ["list"], { ACME_SSF_LICENSE: token });
    expect(authed.exitCode).toBe(0);
    expect(authed.stdout).toContain("notes.md");
  }, 120000);

  test("package ships no sources, maps, or protected plaintext", async () => {
    const { outDir } = await buildFixture();
    const seen: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else {
          seen.push(full.slice(outDir.length + 1));
        }
      }
    };
    walk(outDir);
    expect(seen).not.toContain(join("src", "echo.ts"));
    expect(seen.filter((path) => path.endsWith(".ts") || path.endsWith(".map"))).toEqual([]);
    // The encrypted companion is ciphertext: the author plaintext is absent.
    expect(readFileSync(join(outDir, "scripts", "runtime.bin"), "utf8")).not.toContain("Installed secret notes.");
  }, 120000);

  test("a swapped container magic prefix fails closed before anything runs", async () => {
    const { outDir, token } = await buildFixture();
    const binPath = join(outDir, "scripts", "runtime.bin");
    const bytes = readFileSync(binPath);
    bytes[0] = ((bytes[0] ?? 0) ^ 0xff);
    writeFileSync(binPath, bytes);
    const denied = runNode(outDir, ["list"], { ACME_SSF_LICENSE: token });
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stdout).toContain("ERROR ARTIFACT_INVALID");
  }, 120000);

  test("reads protected files with notice and runs scripts by id", async () => {
    const { outDir, token } = await buildFixture();
    const denied = runNode(outDir, ["read", "secrets/notes.md"]);
    expect(denied.exitCode).toBe(2);
    expect(denied.stdout).toContain("ERROR LICENSE_MISSING");
    const read = runNode(outDir, ["read", "secrets/notes.md"], { ACME_SSF_LICENSE: token });
    expect(read.exitCode).toBe(0);
    expect(read.stdout).toContain("Installed secret notes.");
    expect(read.stdout).toContain("CONFIDENTIAL");
    const run = runNode(outDir, ["run", "echo-args", "--", "hi"], { ACME_SSF_LICENSE: token });
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("[\"hi\"]");
    const bad = runNode(outDir, ["frobnicate"], { ACME_SSF_LICENSE: token });
    expect(bad.exitCode).toBe(4);
    expect(bad.stdout).toContain("ERROR");
  }, 120000);
});
