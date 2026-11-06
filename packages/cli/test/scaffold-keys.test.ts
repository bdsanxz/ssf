// F-69/F-70/F-78: scaffold and key generation.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSkill, newWorkspace } from "../src/scaffold.js";
import { ensureLeaseKeys, generateKeys, loadPublisherKeys } from "../src/keys.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ssf-cli-"));
}

describe("newWorkspace", () => {
  test("creates config and gitignore; refuses a non-empty workspace", () => {
    const dir = join(tmp(), "w");
    const { text } = newWorkspace(dir, "acme");
    expect(text).toContain("acme");
    expect(readFileSync(join(dir, "ssf.config.ts"), "utf8")).toContain("publisher: 'acme'");
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("keys/");
    expect(() => newWorkspace(dir, "acme")).toThrow("already exists");
  });
});

describe("generateSkill", () => {
  test("scaffolds five files and registers the skill", () => {
    const root = tmp();
    newWorkspace(root, "acme");
    const { registered } = generateSkill(root, "pdf-helper", "acme", "ACME_SSF_LICENSE");
    expect(registered).toBe(true);
    for (const file of ["skill.manifest", "SKILL.md", "src/example.ts", "references/guide.md", "test/smoke.test.ts"]) {
      expect(statSync(join(root, "skills", "pdf-helper", file)).isFile()).toBe(true);
    }
    // A nested `bun test` run prints only its banner to captured stdout, so
    // the exit code is the assertion: execFileSync throws when tests fail.
    const smoke = execFileSync(process.execPath, ["test", join(root, "skills", "pdf-helper", "test", "smoke.test.ts")], { encoding: "utf8", timeout: 60000 });
    expect(smoke).toContain("bun test");
    expect(readFileSync(join(root, "skills", "pdf-helper", "skill.manifest"), "utf8")).toContain("id: pdf-helper");
    expect(readFileSync(join(root, "ssf.config.ts"), "utf8")).toContain('"skills/pdf-helper"');
    expect(() => generateSkill(root, "pdf-helper", "acme", "E")).toThrow("already exists");
    expect(() => generateSkill(root, "Bad_Name", "acme", "E")).toThrow("Invalid skill name");
  });
});

describe("keys generate", () => {
  test("writes 0600 key material and refuses to overwrite", () => {
    const dir = tmp();
    const { kid } = generateKeys({ dir, kid: "prod-2026" });
    expect(kid).toBe("prod-2026");
    const mode = (path: string): number => statSync(path).mode & 0o777;
    expect(mode(join(dir, "prod-2026.root.hex"))).toBe(0o600);
    expect(mode(join(dir, "prod-2026.license.pem"))).toBe(0o600);
    expect(statSync(join(dir, "prod-2026.license.pub.pem")).isFile()).toBe(true);
    expect(mode(join(dir, "prod-2026.lease.pem"))).toBe(0o600);
    expect(statSync(join(dir, "prod-2026.lease.pub.pem")).isFile()).toBe(true);
    expect(() => generateKeys({ dir, kid: "prod-2026" })).toThrow("already exist");
    const loaded = loadPublisherKeys(dir, { rootKid: "prod-2026", licenseKid: "prod-2026", artifactKid: "prod-2026" });
    expect(loaded.rootSecret).toHaveLength(32);
    expect(loaded.licensePrivateKeyPem).toContain("PRIVATE KEY");
    expect(loaded.leasePublicKeyPem).toBeUndefined();
    const leased = loadPublisherKeys(dir, {
      rootKid: "prod-2026",
      licenseKid: "prod-2026",
      artifactKid: "prod-2026",
      leaseKid: "prod-2026",
    });
    expect(leased.leasePrivateKeyPem).toContain("PRIVATE KEY");
    expect(leased.leasePublicKeyPem).toContain("PUBLIC KEY");
  });

  test("lease backfill creates only the missing pair", () => {
    const dir = tmp();
    generateKeys({ dir, kid: "prod-2026" });
    rmSync(join(dir, "prod-2026.lease.pem"));
    rmSync(join(dir, "prod-2026.lease.pub.pem"));
    const backfilled = ensureLeaseKeys(dir, "prod-2026");
    expect(backfilled.created).toBe(true);
    expect(backfilled.text).toContain("lease key:");
    expect(ensureLeaseKeys(dir, "prod-2026").created).toBe(false);
    expect(() => ensureLeaseKeys(dir, "")).toThrow("--kid");
    expect(() => loadPublisherKeys(dir, {
      rootKid: "prod-2026",
      licenseKid: "prod-2026",
      artifactKid: "prod-2026",
      leaseKid: "missing",
    })).toThrow("ssf keys lease");
  });

  test("--dev warns that test kids never ship", () => {
    const dir = tmp();
    const { text } = generateKeys({ dir, dev: true });
    expect(text).toContain("kid: dev");
    expect(text).toContain("WARNING");
    expect(() => generateKeys({ dir })).toThrow("--kid");
    expect(() => loadPublisherKeys(dir, { rootKid: "nope", licenseKid: "nope", artifactKid: "nope" })).toThrow("keys generate");
  });
});
