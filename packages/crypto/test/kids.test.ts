// F-19 and F-20 tests: key separation table and test-kid rejection.

import { describe, expect, test } from "bun:test";
import {
  assertProductionKid,
  isTestKid,
  LICENSE_DEV_KEY,
  LicenseKeyError,
} from "../src/kids.js";
import { isValidKid, KEY_SEPARATION } from "../src/separation.js";

describe("key separation", () => {
  test("covers all four purposes with the expected algorithms", () => {
    expect(KEY_SEPARATION["license-sign"].algorithm).toBe("ed25519");
    expect(KEY_SEPARATION["artifact-sign"].algorithm).toBe("ed25519");
    expect(KEY_SEPARATION["lease-sign"].algorithm).toBe("ed25519");
    expect(KEY_SEPARATION["content-root"].algorithm).toBe("hkdf-sha256");
    for (const entry of Object.values(KEY_SEPARATION)) {
      expect(entry.holdsSecret).toBe(true);
      expect(entry.publicMaterialOnly).toBe(true);
    }
  });

  test("validates kid shape", () => {
    expect(isValidKid("prod-2026")).toBe(true);
    expect(isValidKid("dev")).toBe(true);
    expect(isValidKid("")).toBe(false);
    expect(isValidKid("-lead")).toBe(false);
    expect(isValidKid("UPPER")).toBe(false);
  });
});

describe("test kid rejection", () => {
  test("rejects dev and example kids with LICENSE_DEV_KEY", () => {
    expect(isTestKid("dev")).toBe(true);
    expect(isTestKid("example")).toBe(true);
    expect(isTestKid("prod-2026")).toBe(false);
    for (const kid of ["dev", "example"]) {
      try {
        assertProductionKid(kid);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(LicenseKeyError);
        expect((error as LicenseKeyError).code).toBe(LICENSE_DEV_KEY);
      }
    }
  });

  test("accepts production kids", () => {
    expect(() => assertProductionKid("prod-2026")).not.toThrow();
  });
});
