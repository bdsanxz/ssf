// F-39: append-only issuance log (issued.jsonl).
// Every issuance records license id, customer reference, skills, versions,
// issue/expiry dates, and ext claims. The log is for audit and mapping
// licenses to customers; it is not a service database.

import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface IssuanceRecord {
  license_id: string;
  customer?: string;
  skills: string[];
  versions: Record<string, string>;
  issued_at: number;
  expires_at: number;
  ext: Record<string, unknown>;
}

/** Append one issuance record as a single JSON line. */
export function appendIssuance(logPath: string, record: IssuanceRecord): void {
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

/** Read every issuance record. A missing log reads as empty. */
export function listIssuance(logPath: string): IssuanceRecord[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const records: IssuanceRecord[] = [];
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    records.push(JSON.parse(trimmed) as IssuanceRecord);
  }
  return records;
}
