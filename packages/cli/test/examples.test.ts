// F-88: the committed example stays valid and buildable. Copies
// examples/acme-skills to temp (the repo is never mutated), generates a
// throwaway prod-shaped kid, rewrites the example kids, then validates and
// builds both skills for real.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { buildAllSkills } from "@ssf/build";
import { issueLicense } from "@ssf/license";
import type { SsfConfig } from "@ssf/manifest";
import { generateKeys, validateWorkspaceSkills } from "../src/index.js";

const EXAMPLE_DIR = "/Users/budisantoso/Dev/bdsanxz/SsfWorkspace/ssf/examples/acme-skills";

function copyExample(): string {
  const root = mkdtempSync(join(tmpdir(), "ssf-ex-"));
  cpSync(EXAMPLE_DIR, root, {
    recursive: true,
    // Skip dependency links (symlink cycles) and build caches; the copy keeps
    // skills, keys/.gitkeep, manifests, and the workspace config.
    filter: (source) => !source.includes("node_modules") && !source.includes(".turbo"),
  });
  // The copied config imports @ssf/cli; map it back to the monorepo since
  // temp workspaces have no workspace links (same trick as bin.test.ts).
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@ssf/*": ["/Users/budisantoso/Dev/bdsanxz/SsfWorkspace/ssf/packages/*/src/index.ts"] } } }),
  );
  return root;
}

describe("example workspace", () => {
  test("validates clean and builds both skills with throwaway keys", async () => {
    const root = copyExample();
    const report = validateWorkspaceSkills(root, ["skills/pdf-helper", "skills/report-writer"]);
    expect(report.errors).toEqual([]);
    generateKeys({ dir: join(root, "keys"), kid: "citest-2026" });
    const configPath = join(root, "ssf.config.ts");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replaceAll('"example"', '"citest-2026"'));
    const configModule = (await import(configPath)) as { default: SsfConfig };
    const material = {
      rootSecret: Buffer.from(readFileSync(join(root, "keys", "citest-2026.root.hex"), "utf8").trim(), "hex"),
      rootKid: "citest-2026",
      artifactPrivateKey: createPrivateKey(readFileSync(join(root, "keys", "citest-2026.artifact.pem"), "utf8")),
      artifactKid: "citest-2026",
      licensePublicKey: createPublicKey(readFileSync(join(root, "keys", "citest-2026.license.pub.pem"), "utf8")),
    };
    const outcomes = await buildAllSkills(root, ["skills/pdf-helper", "skills/report-writer"], configModule.default, material, { force: true });
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const { token } = issueLicense({
      rootSecret: material.rootSecret,
      licensePrivateKey: createPrivateKey(readFileSync(join(root, "keys", "citest-2026.license.pem"), "utf8")),
      licenseKid: "citest-2026",
      publisher: "acme",
      skills: [{ skillId: "pdf-helper", version: "1.0.0" }],
      expiresAt: nowSeconds + 86400,
      licenseId: "lic_ex",
      nowSeconds,
    });
    const out = execFileSync(process.execPath, [join(root, "dist", "skills", "pdf-helper", "scripts", "runtime.js"), "list", "--scripts"], {
      cwd: tmpdir(),
      env: { ...process.env, ACME_SSF_LICENSE: token },
      encoding: "utf8",
      timeout: 60000,
    });
    expect(out).toContain("extract-table");
    // F-83/F-88: the real skills CLI discovers both example skills in dist.
    const listed = execFileSync("npx", ["-y", "skills", "add", join(root, "dist"), "--list", "-y"], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 180000,
    });
    expect(listed).toContain("pdf-helper");
    expect(listed).toContain("report-writer");
  }, 300000);
});
