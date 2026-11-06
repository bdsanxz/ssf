// F-25b5 + F-16b3/F-25b3-4 evidence: every release input derives from the
// seed. Different seeds ship a different scripts/runtime.js (renaming,
// numeric shapes, key transforms, shuffled init metadata) and a different
// runtime.bin (shuffled field order, seed magic, seeded script bytes), but
// serve identically. The same seed reproduces both files byte for byte.
// The layout envelope itself stays decodable without the seed: field order
// varies, but the integrity hash covers magic plus canonical key-sorted
// bytes, and entry order/ids/metadata never move.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { decodeContainer, generateRootSecret, generateSigningKeypair } from "@ssf/crypto";
import { issueLicense } from "@ssf/license";
import { buildSkill } from "../src/pipeline.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillManifest, SsfConfig } from "@ssf/manifest";

const MANIFEST = [
  "skill:",
  "  id: demo",
  "  version: 1.0.0",
  "  description: Demo skill for seed variation tests. Use when testing diversification.",
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
    limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
    agent: { confidentialityNotice: { enabled: true } },
    build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
    skills: ["skills/demo"],
    plugins: [],
  };
}

interface Built {
  outDir: string;
  token: string;
}

interface KeyMaterial {
  rootSecret: Buffer;
  licensePrivateKey: ReturnType<typeof generateSigningKeypair>["privateKey"];
  licensePublicKey: ReturnType<typeof generateSigningKeypair>["publicKey"];
  artifactPrivateKey: ReturnType<typeof generateSigningKeypair>["privateKey"];
}

function keyMaterial(): KeyMaterial {
  const license = generateSigningKeypair();
  const artifact = generateSigningKeypair();
  return {
    rootSecret: generateRootSecret(),
    licensePrivateKey: license.privateKey,
    licensePublicKey: license.publicKey,
    artifactPrivateKey: artifact.privateKey,
  };
}

// Key material is shared across builds: same-seed byte-identity must come
// from the seed alone, not from fresh keys per build.
async function buildWithSeed(seed: number, keys: KeyMaterial, tag: string): Promise<Built> {
  const root = join(tmpdir(), `ssf-seed-${seed}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  const skill = join(root, "skills", "demo");
  mkdirSync(join(skill, "src"), { recursive: true });
  mkdirSync(join(skill, "secrets"), { recursive: true });
  writeFileSync(join(skill, "skill.manifest"), MANIFEST);
  writeFileSync(join(skill, "SKILL.md"), "# Demo\n\nAuthor text.\n");
  writeFileSync(join(skill, "src", "echo.ts"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(skill, "secrets", "notes.md"), "alpha\n");
  const result = await buildSkill({
    workspaceDir: root,
    skillDir: join("skills", "demo"),
    manifest: parseYaml(MANIFEST) as SkillManifest,
    config: config(),
    keys: {
      rootSecret: keys.rootSecret,
      rootKid: "prod-2026",
      artifactPrivateKey: keys.artifactPrivateKey,
      artifactKid: "prod-2026",
      licensePublicKey: keys.licensePublicKey,
    },
    options: { seedOverride: seed },
  });
  const { token } = issueLicense({
    rootSecret: keys.rootSecret,
    licensePrivateKey: keys.licensePrivateKey,
    licenseKid: "prod-2026",
    publisher: "acme",
    skills: [{ skillId: "demo", version: "1.0.0" }],
    expiresAt: Math.floor(Date.now() / 1000) + 86400,
    licenseId: `lic_seed_${seed}`,
  });
  return { outDir: result.outDir, token };
}

function serve(outDir: string, args: string[], token: string): string {
  return execFileSync(process.execPath, [join(outDir, "scripts", "runtime.js"), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ACME_SSF_LICENSE: token },
    encoding: "utf8",
    timeout: 60000,
  });
}

describe("seed variation", () => {
  test("different seeds vary runtime.js but serve identically; same seed is byte-identical", async () => {
    const keys = keyMaterial();
    const seven = await buildWithSeed(7, keys, "a");
    const eight = await buildWithSeed(8, keys, "b");
    const sevenAgain = await buildWithSeed(7, keys, "c");
    const runtimeJs = (built: Built): string => readFileSync(join(built.outDir, "scripts", "runtime.js"), "utf8");
    const container = (built: Built): Buffer => readFileSync(join(built.outDir, "scripts", "runtime.bin"));
    // F-25b5: different seeds restructure the loader; the same seed
    // reproduces it byte for byte (F-24 determinism through the seed).
    expect(runtimeJs(seven)).not.toBe(runtimeJs(eight));
    expect(runtimeJs(seven)).toBe(runtimeJs(sevenAgain));
    // The container bytes also vary across seeds, because script entries
    // carry the seed-obfuscated bundle; the same seed reproduces them.
    expect(container(seven).equals(container(eight))).toBe(false);
    expect(container(seven).equals(container(sevenAgain))).toBe(true);
    // Fixed v1 layout (F-16b3 open): decoding both containers shows the
    // same envelope, entry order, ids, kinds, and metadata. Only the
    // script ciphertext differs (seeded bundle); the encrypted companion
    // has identical bytes, since its nonce and key derive from content.
    const decoded = (built: Built) => decodeContainer(container(built));
    expect(decoded(seven).format).toBe(2);
    expect(decoded(eight).format).toBe(2);
    const layoutOf = (built: Built) =>
      decoded(built).entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        protection: entry.protection,
        description: entry.description,
        usage: entry.usage,
      }));
    expect(layoutOf(seven)).toEqual(layoutOf(eight));
    const byId = (built: Built) => new Map(decoded(built).entries.map((entry) => [entry.id, entry]));
    const bytesOf = (built: Built, id: string): Buffer => Buffer.from(byId(built).get(id)?.ciphertext ?? new Uint8Array());
    expect(bytesOf(seven, "echo-args").equals(bytesOf(eight, "echo-args"))).toBe(false);
    expect(bytesOf(seven, "secrets/notes.md").equals(bytesOf(eight, "secrets/notes.md"))).toBe(true);
    // Behavior is identical: both loaders serve the same content and run
    // the same script with the same output.
    expect(serve(seven.outDir, ["read", "secrets/notes.md"], seven.token)).toContain("alpha");
    expect(serve(eight.outDir, ["read", "secrets/notes.md"], eight.token)).toContain("alpha");
    expect(serve(seven.outDir, ["run", "echo-args", "--", "hi"], seven.token)).toContain('["hi"]');
    expect(serve(eight.outDir, ["run", "echo-args", "--", "hi"], eight.token)).toContain('["hi"]');
  }, 300000);
});
