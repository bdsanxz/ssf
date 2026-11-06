// F-38, F-39, F-44 tests: clock rollback, issuance log, redaction.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendIssuance, listIssuance } from "../src/issuance.js";
import { detectClockRollback, readLastSeen, writeLastSeen } from "../src/lastSeen.js";
import { redactSecrets } from "../src/redaction.js";

describe("issuance log", () => {
  test("appends and lists records", () => {
    const log = join(mkdtempSync(join(tmpdir(), "ssf-issued-")), "issued.jsonl");
    expect(listIssuance(log)).toEqual([]);
    appendIssuance(log, {
      license_id: "lic_1",
      customer: "ref-123",
      skills: ["pdf-helper"],
      versions: { "pdf-helper": "1.0.0" },
      issued_at: 1000,
      expires_at: 2000,
      ext: {},
    });
    const records = listIssuance(log);
    expect(records.length).toBe(1);
    expect(records[0]?.customer).toBe("ref-123");
  });
});

describe("last_seen", () => {
  test("detects clock rollback with tolerance", () => {
    const dir = mkdtempSync(join(tmpdir(), "ssf-state-"));
    expect(readLastSeen(dir)).toBeNull();
    expect(detectClockRollback(null, 1000)).toBe(false);
    writeLastSeen(dir, 2000);
    expect(readLastSeen(dir)).toBe(2000);
    expect(detectClockRollback(2000, 1900)).toBe(true);
    expect(detectClockRollback(2000, 1990)).toBe(false);
    expect(detectClockRollback(2000, 2100)).toBe(false);
  });
});

describe("redactSecrets", () => {
  test("masks known secrets and leaves other text", () => {
    const out = redactSecrets("token unit-test-secret-value failed", ["unit-test-secret-value", "short", null]);
    expect(out).toBe("token [REDACTED] failed");
  });
});
