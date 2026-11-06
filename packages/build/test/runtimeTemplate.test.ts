// Build embeds the lease verification key when keys.leaseKid is set.

import { describe, expect, test } from "bun:test";
import { renderRuntimeSource } from "../src/runtimeTemplate.js";

function meta(leasePublicKeyPem?: string) {
  return {
    skillId: "demo",
    version: "1.0.0",
    publisher: "acme",
    licenseEnvVar: "ACME_SSF_LICENSE",
    licensePublicKeyPem: "license-pem",
    leasePublicKeyPem,
    artifactPublicKeyPem: "artifact-pem",
    artifactKid: "prod-2026",
    artifactSignatureHex: "ab".repeat(32),
    seedHex: "00".repeat(32),
    pluginNames: [],
    dev: false,
    containerLayout: 2,
    installedEntryFile: "@ssf/runtime/src/installed.ts",
  };
}

describe("renderRuntimeSource lease key", () => {
  test("embeds the lease public key when present", () => {
    const source = renderRuntimeSource(meta("lease-pem"));
    expect(source).toContain("lease-pem");
  });

  test("omits the field when no lease kid is configured", () => {
    const source = renderRuntimeSource(meta(undefined));
    expect(source).not.toContain("leasePublicKeyPem");
    expect(source).toContain("licensePublicKeyPem");
  });
});
