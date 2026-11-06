// F-40: ssf license issue/verify/list commands.
// Issue mints multi-skill tokens with publisher key material and records
// them in issued.jsonl; verify checks a token locally; list reads the log.
// Key material only ever comes from explicit files or admin environments,
// never from the repo. Tokens print on stdout because that is the point of
// issue; nothing else in this command prints secrets.

import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { join } from "node:path";
import {
  appendIssuance,
  issueLicense,
  listIssuance,
  revokeLicenseId,
  verifyLicenseToken,
  type LicensePayload,
} from "@ssf/license";
import { validateSsfConfig, type SsfConfig } from "@ssf/manifest";
import { runChainable } from "@ssf/plugin-api";
import { loadPublisherKeys } from "./keys.js";
import { loadWorkspacePlugins } from "./plugins.js";

export interface LicenseIssueFlags {
  skills: string[];
  expires: string;
  customer?: string;
  extJson?: string;
  mode?: string;
  licenseId?: string;
  /** Explicit overrides; when empty the workspace keys dir resolves them. */
  rootSecretFile?: string;
  licenseKeyFile?: string;
  licenseKid?: string;
}

export interface LicenseContext {
  workspaceDir: string;
  config: SsfConfig;
}

function readHexFile(path: string, what: string): Buffer {
  const text = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length !== 64) {
    throw new Error(`${what} must be 64 hex chars (32 bytes).`);
  }
  return Buffer.from(text, "hex");
}

function readPrivateKeyPem(path: string): KeyObject {
  return createPrivateKey(readFileSync(path, "utf8"));
}

/** Parse an expiry flag: ISO date or "<n>d" days from now. */
export function parseExpiry(expires: string, nowSeconds: number): number {
  const days = /^(\d+)d$/.exec(expires.trim());
  if (days) {
    return nowSeconds + Number.parseInt(days[1] as string, 10) * 86400;
  }
  const millis = Date.parse(expires.trim());
  if (!Number.isFinite(millis)) {
    throw new Error(`Cannot parse --expires value: ${expires}. Use an ISO date or "<n>d".`);
  }
  return Math.floor(millis / 1000);
}

function parseSkills(values: string[]): Array<{ skillId: string; version: string }> {
  return values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const at = part.lastIndexOf("@");
        if (at <= 0 || at === part.length - 1) {
          throw new Error(`Each --skills entry needs id@version, got: ${part}`);
        }
        return { skillId: part.slice(0, at), version: part.slice(at + 1) };
      }),
  );
}

/** Issue a token for one workspace and record it. Returns printable output. */
export async function licenseIssue(
  flags: LicenseIssueFlags,
  context: LicenseContext,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ text: string; token: string }> {
  const configErrors = validateSsfConfig(context.config);
  if (configErrors.errors.length > 0) {
    throw new Error(`Workspace config is invalid: ${configErrors.errors.join("; ")}`);
  }
  const skills = parseSkills(flags.skills);
  if (skills.length === 0) {
    throw new Error("Issue needs at least one --skills id@version entry.");
  }
  const expiresAt = parseExpiry(flags.expires, nowSeconds);
  if (expiresAt <= nowSeconds) {
    throw new Error("Expiry must be in the future.");
  }
  // Key material: explicit files win, otherwise the workspace keys dir.
  const keysDir = join(context.workspaceDir, context.config.keys.dir);
  const licenseKid = flags.licenseKid ?? context.config.keys.licenseKid;
  const rootSecret = flags.rootSecretFile ? readHexFile(flags.rootSecretFile, "Root secret") : loadPublisherKeys(keysDir, { rootKid: context.config.keys.rootKid, licenseKid, artifactKid: context.config.keys.artifactKid }).rootSecret;
  const licensePrivateKey = flags.licenseKeyFile
    ? readPrivateKeyPem(flags.licenseKeyFile)
    : createPrivateKey(loadPublisherKeys(keysDir, { rootKid: context.config.keys.rootKid, licenseKid, artifactKid: context.config.keys.artifactKid }).licensePrivateKeyPem);
  // Build issueLicense hooks may only add ext claims; explicit --ext-json
  // wins over plugin claims. Fires here (F-79); validated in F-64.
  const plugins = await loadWorkspacePlugins(context.workspaceDir, context.config.plugins);
  const issuers = plugins.filter((plugin) => plugin.build?.issueLicense);
  let draft: { ext: Record<string, string> } = { ext: {} };
  if (issuers.length > 0) {
    const base = {
      publisher: context.config.workspace.publisher,
      skillId: skills[0]?.skillId ?? "",
      version: skills[0]?.version ?? "",
      lang: "en" as const,
    };
    const result = await runChainable(
      issuers,
      "build.issueLicense",
      base,
      draft,
      (plugin, hookContext, current) =>
        plugin.build!.issueLicense!({ ext: { ...current.ext } }, {
          ...hookContext,
          customer: flags.customer,
          skills: skills.map((skill) => skill.skillId),
        }),
      (value) => typeof value === "object" && value !== null && typeof (value as { ext?: unknown }).ext === "object",
    );
    for (const key of Object.keys(result)) {
      if (key !== "ext") {
        throw new Error(`License plugin may only add ext claims (found "${key}").`);
      }
    }
    draft = { ext: { ...result.ext } };
  }
  const explicitExt = flags.extJson ? (JSON.parse(flags.extJson) as Record<string, unknown>) : {};
  const ext = { ...draft.ext, ...explicitExt };
  if (flags.mode !== undefined && flags.mode !== "offline" && flags.mode !== "online") {
    throw new Error(`Cannot parse --mode value: ${flags.mode}. Use "offline" or "online".`);
  }
  const { token, payload } = issueLicense({
    rootSecret,
    licensePrivateKey,
    licenseKid,
    publisher: context.config.workspace.publisher,
    skills,
    expiresAt,
    licenseId: flags.licenseId,
    nowSeconds,
    ext,
    mode: flags.mode === "online" ? "online" : "offline",
  });
  appendIssuance(join(context.workspaceDir, "issued.jsonl"), {
    license_id: payload.license_id,
    customer: flags.customer,
    skills: payload.skills,
    versions: Object.fromEntries(skills.map((skill) => [skill.skillId, skill.version])),
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    ext: payload.ext,
  });
  const lines = [
    `license_id: ${payload.license_id}`,
    `mode: ${payload.mode}`,
    `skills: ${payload.skills.join(", ")}`,
    `expires: ${new Date(payload.expires_at * 1000).toISOString()}`,
    "",
    token,
  ];
  return { text: lines.join("\n"), token };
}

export interface VerifyFlags {
  publicKeyFile: string;
}

/** Verify a token locally and summarize it without printing keys. */
export function licenseVerify(token: string, flags: VerifyFlags): { text: string } {
  const publicKey = createPublicKey(readFileSync(flags.publicKeyFile, "utf8"));
  let payload: LicensePayload;
  try {
    payload = verifyLicenseToken(token.trim(), { licensePublicKey: publicKey });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Token is not valid.");
  }
  const lines = [
    "valid: true",
    `license_id: ${payload.license_id}`,
    `publisher: ${payload.publisher}`,
    `mode: ${payload.mode}`,
    `skills: ${payload.skills.join(", ")}`,
    `content_keys: ${Object.keys(payload.content_keys).length} keys (values hidden)`,
    `expires: ${new Date(payload.expires_at * 1000).toISOString()}`,
  ];
  return { text: lines.join("\n") };
}

export interface LicenseRevokeFlags {
  /** Revocation file; defaults to revoked.json in the workspace. */
  revocationsFile?: string;
}

/**
 * F-42: append a license id to the revocation list. The service reads the
 * file with a short TTL, so revocation takes effect no later than the next
 * lease expiry. Offline tokens cannot be revoked: they carry their own
 * keys, so removing the token from clients is the only remedy.
 */
export function licenseRevoke(
  id: string,
  flags: LicenseRevokeFlags,
  context: LicenseContext,
): { text: string } {
  if (id.trim().length === 0) {
    throw new Error("ssf license revoke needs a license id.");
  }
  const file = flags.revocationsFile ?? join(context.workspaceDir, "revoked.json");
  const list = revokeLicenseId(file, id.trim());
  return { text: `revoked: ${id.trim()} (${list.revoked.length} total) -> ${file}` };
}

/** List issuance records without printing key material. */
export function licenseList(logPath: string): { text: string } {
  const records = listIssuance(logPath);
  if (records.length === 0) {
    return { text: "No licenses issued yet." };
  }
  const lines = records.map(
    (record) =>
      `${record.license_id}  ${(record.customer ?? "-").padEnd(12)}  ${record.skills.join(",")}  expires ${new Date(record.expires_at * 1000).toISOString().slice(0, 10)}`,
  );
  return { text: lines.join("\n") };
}
