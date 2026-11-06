// F-75/F-76: release builds and dev builds.
// Release builds are deterministic (same inputs, same bytes) and refuse to
// overwrite a recorded version without --force. Dev builds use a random seed
// with kid dev keys, always force, and run the installed runtime once with
// a short-lived local dev license.

import { execFileSync } from "node:child_process";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAllSkills, buildSkill, type BuildResult } from "@ssf/build";
import { parseSkillManifestText } from "@ssf/manifest";
import { issueLicense } from "@ssf/license";
import type { SsfConfig } from "@ssf/manifest";
import { readFileSync } from "node:fs";
import { ensureLeaseKeys, generateKeys, loadPublisherKeys } from "./keys.js";
import { loadWorkspacePlugins } from "./plugins.js";

export interface BuildFlags {
  skill?: string;
  all?: boolean;
  seed?: number;
  force?: boolean;
  /**
   * Per-customer cut (F-93): builds with a customer root secret into
   * dist/customers/<ref>/ plus a separate releases log, so customer keys
   * never mix with the shared distribution cut. Requires rootSecretFile.
   */
  customer?: string;
  /** Hex root secret overriding the workspace one (per-customer builds). */
  rootSecretFile?: string;
}

function skillDirsFor(config: SsfConfig, skill?: string): string[] {
  if (!skill) {
    return config.skills;
  }
  const selected = config.skills.filter((dir) => dir === skill || dir.endsWith(`/${skill}`));
  if (selected.length === 0) {
    throw new Error(`Skill "${skill}" is not listed in ssf.config.ts skills.`);
  }
  return selected;
}

function toArtifactKeys(material: {
  rootSecret: Buffer;
  licensePublicKeyPem: string;
  artifactPrivateKeyPem: string;
  leasePublicKeyPem?: string;
}, kids: { rootKid: string; artifactKid: string }) {
  return {
    rootSecret: material.rootSecret,
    rootKid: kids.rootKid,
    artifactPrivateKey: createPrivateKey(material.artifactPrivateKeyPem),
    artifactKid: kids.artifactKid,
    licensePublicKey: createPublicKey(material.licensePublicKeyPem),
    leasePublicKey: material.leasePublicKeyPem === undefined ? undefined : createPublicKey(material.leasePublicKeyPem),
  };
}

function describeResult(result: BuildResult): string {
  const capabilities = result.plugins.capabilities.map(
    (entry) => `${entry.name}${entry.capabilities.length > 0 ? ` [${entry.capabilities.join(", ")}]` : ""}`,
  );
  const lines = [
    `built ${result.skillId}@${result.version} -> ${result.outDir} (${result.hash.slice(0, 12)})`,
    `  plugins: ${capabilities.join(", ") || "none"}`,
    `  embedded: ${result.plugins.embeddedPlugins.join(", ") || "none"}`,
  ];
  const transformed = result.plugins.transforms.source + result.plugins.transforms.companion;
  if (transformed > 0) {
    lines.push(`  transforms: ${result.plugins.transforms.source} source, ${result.plugins.transforms.companion} companion`);
  }
  if (result.plugins.directApiOnly.length > 0) {
    lines.push(`  direct-API-only runtime hooks: ${result.plugins.directApiOnly.join(", ")}`);
  }
  return lines.join("\n");
}

/** Run a release build for one skill or the whole workspace. */
export async function buildCommand(
  workspaceDir: string,
  config: SsfConfig,
  flags: BuildFlags,
): Promise<{ text: string }> {
  if (flags.customer !== undefined && (flags.customer.trim().length === 0 || flags.rootSecretFile === undefined)) {
    throw new Error("Per-customer builds need --customer <ref> and --root-secret-file <hex> together.");
  }
  if (flags.rootSecretFile !== undefined && flags.customer === undefined) {
    throw new Error("--root-secret-file needs --customer <ref>: customer keys must build into their own cut.");
  }
  const customer = flags.customer?.trim();
  if (customer !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(customer)) {
    throw new Error("--customer must be a safe reference (letters, digits, dash, underscore).");
  }
  const targets = flags.skill ? skillDirsFor(config, flags.skill) : config.skills;
  if (targets.length === 0) {
    throw new Error("No skills listed in ssf.config.ts skills.");
  }
  const keysDir = join(workspaceDir, config.keys.dir);
  const material = loadPublisherKeys(keysDir, { rootKid: config.keys.rootKid, licenseKid: config.keys.licenseKid, artifactKid: config.keys.artifactKid, leaseKid: config.keys.leaseKid });
  if (flags.rootSecretFile !== undefined) {
    const hex = readFileSync(flags.rootSecretFile, "utf8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("--root-secret-file must hold 64 hex chars (32 bytes).");
    }
    material.rootSecret = Buffer.from(hex, "hex");
  }
  const plugins = await loadWorkspacePlugins(workspaceDir, config.plugins);
  const keys = toArtifactKeys(material, { rootKid: config.keys.rootKid, artifactKid: config.keys.artifactKid });
  const options = {
    force: flags.force,
    seedOverride: flags.seed,
    plugins,
    distSkillsDir: customer === undefined ? undefined : join("dist", "customers", customer, "skills"),
    releasesLog: customer === undefined ? undefined : join("dist", "customers", customer, "releases.jsonl"),
  };
  const lines: string[] = [];
  const outcomes = await buildAllSkills(workspaceDir, targets, config, keys, options);
  for (const outcome of outcomes) {
    if (!outcome.ok || !outcome.result) {
      throw new Error(`Build failed for ${outcome.dir}: ${outcome.error ?? "unknown error"}. Use --force to rebuild a recorded version.`);
    }
    lines.push(describeResult(outcome.result));
  }
  return { text: lines.join("\n") };
}

/** Dev build: random seed, kid dev keys, short-lived local token, one run. */
export async function devCommand(
  workspaceDir: string,
  config: SsfConfig,
  skill: string,
): Promise<{ text: string }> {
  const dirs = skillDirsFor(config, skill);
  const dir = dirs[0] as string;
  const keysDir = join(workspaceDir, config.keys.dir);
  let ensured = false;
  try {
    loadPublisherKeys(keysDir, { rootKid: "dev", licenseKid: "dev", artifactKid: "dev" });
  } catch {
    generateKeys({ dir: keysDir, dev: true });
    ensured = true;
  }
  // Lease keys postdate the first dev workspaces; backfill without rotation.
  ensureLeaseKeys(keysDir, "dev");
  const material = loadPublisherKeys(keysDir, { rootKid: "dev", licenseKid: "dev", artifactKid: "dev", leaseKid: "dev" });
  // Dev builds always force: the random seed changes the hash every run, so
  // a recorded version can never match again.
  const keys = toArtifactKeys(material, { rootKid: "dev", artifactKid: "dev" });
  const plugins = await loadWorkspacePlugins(workspaceDir, config.plugins);
  const manifest = parseSkillManifestText(readFileSync(join(workspaceDir, dir, "skill.manifest"), "utf8"));
  const result = await buildSkill({
    workspaceDir,
    skillDir: dir,
    manifest,
    config,
    keys,
    options: { dev: true, force: true, plugins },
    plugins,
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const { token } = issueLicense({
    rootSecret: material.rootSecret,
    licensePrivateKey: createPrivateKey(material.licensePrivateKeyPem),
    licenseKid: "dev",
    publisher: config.workspace.publisher,
    skills: [{ skillId: result.skillId, version: result.version }],
    expiresAt: nowSeconds + 7 * 86400,
    licenseId: `dev-${nowSeconds}`,
    nowSeconds,
  });
  const envName = config.license.env;
  let output: string;
  try {
    output = execFileSync(process.execPath, [join(result.outDir, "scripts", "runtime.js"), "list"], {
      cwd: tmpdir(),
      env: { ...process.env, [envName]: token },
      encoding: "utf8",
      timeout: 60000,
    });
  } catch (error) {
    const failure = error as { stdout?: unknown; status?: unknown };
    throw new Error(`Dev run failed (exit ${String(failure.status ?? "?")}): ${String(failure.stdout ?? "")}`);
  }
  const banner = ensured
    ? "DEV BUILD (keys generated with kid dev; test kids never work in production)."
    : "DEV BUILD (kid dev; test kids never work in production).";
  return { text: [banner, describeResult(result), "--- runtime list ---", output.trimEnd()].join("\n") };
}
