#!/usr/bin/env node
// Local dev entry for the ssf runtime CLI.
// Installed packages run the bundled scripts/runtime.js instead.

import { runInstalled } from "./installed.js";

const skillDir = process.argv[2];
if (!skillDir) {
  process.stdout.write("Usage: ssf-runtime <skill-dir> <command> [args...]\n");
  process.exitCode = 2;
} else {
  const meta = {
    skillId: process.env["SSF_SKILL_ID"] ?? "unknown",
    version: process.env["SSF_SKILL_VERSION"] ?? "0.0.0",
    publisher: process.env["SSF_PUBLISHER"] ?? "unknown",
    licenseEnvVar: process.env["SSF_LICENSE_ENV"] ?? "SSF_LICENSE",
    licensePublicKeyPem: process.env["SSF_LICENSE_PUBLIC_KEY"] ?? "",
    artifactPublicKeyPem: process.env["SSF_ARTIFACT_PUBLIC_KEY"] ?? "",
    artifactKid: process.env["SSF_ARTIFACT_KID"] ?? "",
    artifactSignatureHex: process.env["SSF_ARTIFACT_SIGNATURE"] ?? "",
    seedHex: process.env["SSF_SEED"] ?? "",
  };
  process.exitCode = await runInstalled({
    runtimeJsPath: `${skillDir}/scripts/runtime.js`,
    meta,
    argv: process.argv.slice(3),
    env: process.env,
  });
}
