// F-77: pack/unpack behavior, refusals, tamper detection, determinism.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeContainer } from "@ssf/crypto";
import { buildCommand } from "../src/buildCmd.js";
import { generateKeys } from "../src/keys.js";
import { packSkill, tgzCompress, tarCreate, unpackSkill, type PackErrorCode } from "../src/pack.js";
import type { SsfConfig } from "@ssf/manifest";

function config(skills: string[]): SsfConfig {
  return {
    workspace: { publisher: "acme", defaultMode: "offline" },
    license: { env: "ACME_SSF_LICENSE", configFile: "acme/license" },
    keys: { dir: "./keys", licenseKid: "citest-2026", artifactKid: "citest-2026", rootKid: "citest-2026" },
    limits: { defaultMaxLines: 500, defaultMaxChars: 40000, defaultScriptOutputChars: 20000, defaultScriptTimeoutSeconds: 120 },
    agent: { confidentialityNotice: { enabled: true } },
    build: { obfuscate: { scripts: true, runtime: true }, diversify: true },
    skills,
    plugins: [],
  };
}

const PUBLIC_MANIFEST = [
  "skill:",
  "  id: postcard",
  "  version: 1.0.0",
  "  description: Public postcard skill for pack tests. Use when verifying distribution archives.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: references/hello.md",
  "    protection: none",
  "    description: Hello guide",
  "",
].join("\n");

const TIERED_MANIFEST = [
  "skill:",
  "  id: vault",
  "  version: 1.0.0",
  "  description: Vault skill with protected content for pack refusal tests. Use when verifying tier refusal.",
  "  license: Proprietary",
  "",
  "license:",
  "  mode: offline",
  "",
  "companion_files:",
  "  - path: secrets/notes.md",
  "    protection: encrypted",
  "    description: Secret notes",
  "",
].join("\n");

function workspace(skillId: string, manifest: string, files: Record<string, string>): { root: string; cfg: SsfConfig } {
  const root = mkdtempSync(join(tmpdir(), "ssf-pack-"));
  const skill = join(root, "skills", skillId);
  for (const [path, content] of Object.entries(files)) {
    const full = join(skill, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  writeFileSync(join(skill, "skill.manifest"), manifest);
  generateKeys({ dir: join(root, "keys"), kid: "citest-2026", force: true });
  return { root, cfg: config([join("skills", skillId)]) };
}

async function expectCode(fn: () => unknown, code: PackErrorCode): Promise<void> {
  try {
    await fn();
  } catch (error) {
    expect((error as { code?: unknown }).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} but the call succeeded.`);
}

describe("pack and unpack", () => {
  test("packs a public skill deterministically and unpacks a serving copy", async () => {
    const { root, cfg } = workspace("postcard", PUBLIC_MANIFEST, {
      "SKILL.md": "# Postcard\n\nAuthor text.\n",
      "references/hello.md": "Hello.\n",
    });
    await buildCommand(root, cfg, {});
    const first = packSkill(root, {});
    expect(first.skillId).toBe("postcard");
    expect(first.outFile.endsWith("postcard-1.0.0.tgz")).toBe(true);
    const second = packSkill(root, { force: true });
    expect(readFileSync(second.outFile).equals(readFileSync(first.outFile))).toBe(true);
    await expectCode(() => packSkill(root, {}), "BUILD_FILE_EXISTS");
    const unpacked = unpackSkill(first.outFile, { dir: join(mkdtempSync(join(tmpdir(), "ssf-unpack-")), "postcard") });
    expect(unpacked.skillId).toBe("postcard");
    const out = execFileSync(process.execPath, [join(unpacked.dir, "scripts", "runtime.js"), "list"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 60000,
    });
    expect(out).toContain("postcard");
    expect(out).toContain("hello.md");
  }, 300000);

  test("refuses tiered skills and dev containers", async () => {
    const tiered = workspace("vault", TIERED_MANIFEST, {
      "SKILL.md": "# Vault\n\nAuthor text.\n",
      "secrets/notes.md": "alpha\n",
    });
    await buildCommand(tiered.root, tiered.cfg, {});
    await expectCode(() => packSkill(tiered.root, {}), "BUILD_TIER_PACK_REFUSED");
    const plain = workspace("postcard", PUBLIC_MANIFEST, {
      "SKILL.md": "# Postcard\n\nAuthor text.\n",
      "references/hello.md": "Hello.\n",
    });
    await buildCommand(plain.root, plain.cfg, {});
    const devDir = join(plain.root, "dist", "skills", "devfake", "scripts");
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(devDir, "runtime.bin"), encodeContainer("dev", []));
    await expectCode(() => packSkill(plain.root, { skill: "devfake" }), "BUILD_DEV_PACK_REFUSED");
  }, 300000);

  test("tampered archives and escaping entries fail closed on unpack", async () => {
    const { root, cfg } = workspace("postcard", PUBLIC_MANIFEST, {
      "SKILL.md": "# Postcard\n\nAuthor text.\n",
      "references/hello.md": "Hello.\n",
    });
    await buildCommand(root, cfg, {});
    const packed = packSkill(root, {});
    const bytes = Buffer.from(readFileSync(packed.outFile));
    const middle = Math.floor(bytes.length / 2);
    bytes[middle] = ((bytes[middle] ?? 0) ^ 0xff);
    const tampered = join(tmpdir(), `ssf-tampered-${Date.now()}.tgz`);
    writeFileSync(tampered, bytes);
    await expectCode(() => unpackSkill(tampered, { dir: join(tmpdir(), `ssf-unpack-${Date.now()}-b`) }), "ARTIFACT_TAMPERED");
    const evil = join(tmpdir(), `ssf-evil-${Date.now()}.tgz`);
    writeFileSync(evil, tgzCompress(tarCreate([{ path: "../evil.txt", data: Buffer.from("x"), dir: false }])));
    await expectCode(() => unpackSkill(evil, { dir: join(tmpdir(), `ssf-unpack-${Date.now()}-c`) }), "ARTIFACT_TAMPERED");
  }, 300000);
});
