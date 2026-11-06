// F-42: revocation list model shared by the CLI writer and the service
// reader. The list is a plain JSON document in private or object storage:
// { "updated_at": 1793923200, "revoked": ["lic_123"] }. Revocation takes
// effect no later than the next lease expiry (leases are short-lived).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RevocationList {
  updated_at: number;
  revoked: string[];
}

/** Structural check for a parsed revocation document. */
export function parseRevocationList(value: unknown): RevocationList {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Revocation list must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["updated_at"] !== "number" || !Array.isArray(record["revoked"])) {
    throw new Error("Revocation list needs updated_at and revoked[].");
  }
  for (const entry of record["revoked"] as unknown[]) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("Revocation list entries must be non-empty strings.");
    }
  }
  return { updated_at: record["updated_at"] as number, revoked: [...(record["revoked"] as string[])] };
}

/** True when the license id appears on the list. */
export function isRevoked(list: RevocationList, licenseId: string): boolean {
  return list.revoked.includes(licenseId);
}

/** Read a revocation file; missing files mean "nothing revoked yet". */
export function readRevocationListFile(path: string): RevocationList | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Revocation file ${path} is not valid JSON.`);
  }
  return parseRevocationList(parsed);
}

/** Write a revocation list (pretty JSON with a trailing newline). */
export function writeRevocationListFile(path: string, list: RevocationList): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ updated_at: list.updated_at, revoked: list.revoked }, null, 2)}\n`, {
    encoding: "utf8",
  });
}

/**
 * Append a license id to the revocation file (idempotent). Creates the
 * file when it does not exist yet and returns the resulting list.
 */
export function revokeLicenseId(path: string, licenseId: string, nowSeconds?: number): RevocationList {
  if (licenseId.length === 0) {
    throw new Error("Revocation needs a license id.");
  }
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const current = readRevocationListFile(path) ?? { updated_at: now, revoked: [] };
  const revoked = current.revoked.includes(licenseId) ? current.revoked : [...current.revoked, licenseId];
  const list: RevocationList = { updated_at: now, revoked };
  writeRevocationListFile(path, list);
  return list;
}
