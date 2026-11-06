// F-31: releases.jsonl append-only log with version immutability.
// Every release records the artifact hash. Rebuilding the same version from
// changed inputs is rejected unless --force passes, so released versions
// stay byte-stable for skills check and update flows.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface ReleaseRecord {
  skill: string;
  version: string;
  hash: string;
  kid: string;
}

export class ReleaseConflictError extends Error {
  constructor(skillId: string, version: string) {
    super(`Version ${version} of skill ${skillId} was already released with different content. Use --force to overwrite.`);
    this.name = "ReleaseConflictError";
  }
}

/** Read every release record from the log. Missing logs read as empty. */
export function readReleases(logPath: string): ReleaseRecord[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const records: ReleaseRecord[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as ReleaseRecord);
  }
  return records;
}

/** Find the recorded hash for one skill version, if any. Latest entry wins. */
export function findReleaseHash(records: ReleaseRecord[], skillId: string, version: string): string | null {
  let hash: string | null = null;
  for (const record of records) {
    if (record.skill === skillId && record.version === version) {
      hash = record.hash;
    }
  }
  return hash;
}

/**
 * Append a release record. The same version with the same hash is a no-op
 * (idempotent rebuilds stay quiet); a changed hash needs force: true.
 */
export function recordRelease(logPath: string, record: ReleaseRecord, options: { force?: boolean } = {}): void {
  const existing = findReleaseHash(readReleases(logPath), record.skill, record.version);
  if (existing === record.hash) {
    return;
  }
  if (existing !== null && !options.force) {
    throw new ReleaseConflictError(record.skill, record.version);
  }
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
}
