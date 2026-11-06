// F-31 tests: release log with version immutability.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReleaseHash, readReleases, recordRelease, ReleaseConflictError } from "../src/releases.js";

function logPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ssf-releases-")), "releases.jsonl");
}

describe("recordRelease", () => {
  test("appends and reads records", () => {
    const path = logPath();
    expect(readReleases(path)).toEqual([]);
    recordRelease(path, { skill: "demo", version: "1.0.0", hash: "aaa", kid: "prod-2026" });
    expect(findReleaseHash(readReleases(path), "demo", "1.0.0")).toBe("aaa");
  });

  test("rebuilds with the same hash are idempotent", () => {
    const path = logPath();
    const record = { skill: "demo", version: "1.0.0", hash: "aaa", kid: "prod-2026" };
    recordRelease(path, record);
    recordRelease(path, record);
    expect(readReleases(path).length).toBe(1);
  });

  test("changed content needs --force", () => {
    const path = logPath();
    recordRelease(path, { skill: "demo", version: "1.0.0", hash: "aaa", kid: "prod-2026" });
    expect(() =>
      recordRelease(path, { skill: "demo", version: "1.0.0", hash: "bbb", kid: "prod-2026" }),
    ).toThrow(ReleaseConflictError);
    recordRelease(path, { skill: "demo", version: "1.0.0", hash: "bbb", kid: "prod-2026" }, { force: true });
    expect(findReleaseHash(readReleases(path), "demo", "1.0.0")).toBe("bbb");
  });
});
