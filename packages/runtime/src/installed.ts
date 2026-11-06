// Installed skill entry point (F-47, F-55).
// The bundled scripts/runtime.js calls runInstalled with its own location,
// so the container resolves next to the runtime file and state lives in the
// user config dir, never in the skill folder. The embedded metadata and keys
// come from the build; only production public keys are embedded.

import { createPublicKey, hkdfSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRuntime } from "./api.js";
import { formatRuntimeErrorFor, parseArgv, executeCommand } from "./cli.js";
import { RuntimeError, formatRuntimeError } from "@ssf/agent-contract";
import { defaultRuntimePluginNames, resolveEmbeddedPlugins } from "@ssf/plugins";
import { CONTAINER_FORMAT_SEEDED, CONTAINER_MAGIC_BYTES } from "@ssf/crypto";

export interface InstalledMeta {
  skillId: string;
  version: string;
  publisher: string;
  licenseEnvVar: string;
  licensePublicKeyPem: string;
  /** Lease verification key PEM; embedded when keys.leaseKid is set. */
  leasePublicKeyPem?: string;
  artifactPublicKeyPem: string;
  artifactKid: string;
  artifactSignatureHex: string;
  seedHex: string;
  /** Builtin runtime plugin names embedded at build time (F-67). */
  pluginNames?: string[];
  /** True for dev builds: accepts kid dev keys and warns loudly. */
  dev?: boolean;
  /** Container layout the release was built with (F-16b3, F-25). */
  containerLayout?: number;
}

export interface InstalledOptions {
  runtimeJsPath: string;
  meta: InstalledMeta;
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
  nowSeconds?: number;
}

/** Run the installed skill CLI. Returns the process exit code. */
export async function runInstalled(options: InstalledOptions): Promise<number> {
  const skillDir = dirname(dirname(options.runtimeJsPath));
  let command;
  try {
    command = parseArgv(options.argv);
  } catch (error) {
    const { text, exitCode } = formatRuntimeErrorFor(error);
    process.stdout.write(`${text}\n`);
    return exitCode;
  }
  // Embedded names resolve to builtin implementations only; an unknown
  // name means the package was tampered with, so installation fails closed.
  // The bundled @ssf/plugins code ships inside runtime.js (F-67).
  if (options.meta.dev === true) {
    process.stderr.write("WARNING: dev build with test keys (kid dev). Dev packages must never be published.\n");
  }
  // F-16b3: the release seed recorded in the meta must predict the
  // container magic prefix. A swapped or edited prefix fails closed here,
  // before any license check or decryption runs.
  if (options.meta.containerLayout === CONTAINER_FORMAT_SEEDED) {
    const seed = Buffer.from(options.meta.seedHex, "hex");
    const expected = Buffer.from(hkdfSync("sha256", seed, Buffer.alloc(0), "ssf/magic", CONTAINER_MAGIC_BYTES));
    let prefix: Buffer;
    try {
      const file = readFileSync(join(skillDir, "scripts", "runtime.bin"));
      prefix = file.subarray(0, CONTAINER_MAGIC_BYTES);
    } catch {
      prefix = Buffer.alloc(0);
    }
    if (prefix.length !== expected.length || !prefix.equals(expected)) {
      const error = new RuntimeError("ARTIFACT_INVALID", "Skill package is damaged or modified; the container magic does not match this release.");
      process.stdout.write(`${formatRuntimeError(error)}\n`);
      return error.exitCode;
    }
  }
  const runtime = createRuntime({
    skillDir,
    publisher: options.meta.publisher,
    skillId: options.meta.skillId,
    version: options.meta.version,
    dev: options.meta.dev === true,
    plugins: resolveEmbeddedPlugins(options.meta.pluginNames ?? defaultRuntimePluginNames()),
    keys: {
      licensePublicKey: createPublicKey(options.meta.licensePublicKeyPem),
      artifactPublicKey: createPublicKey(options.meta.artifactPublicKeyPem),
      artifactKid: options.meta.artifactKid,
      artifactSignature: Buffer.from(options.meta.artifactSignatureHex, "hex"),
      leasePublicKey:
        options.meta.leasePublicKeyPem === undefined ? undefined : createPublicKey(options.meta.leasePublicKeyPem),
    },
    licenseEnvVar: options.meta.licenseEnvVar,
    licenseServiceUrl: options.env?.["SSF_LICENSE_SERVICE_URL"],
    token: command.token ?? options.env?.["SSF_TOKEN"],
    stateDir: options.stateDir,
    nowSeconds: options.nowSeconds,
  });
  try {
    const { text, exitCode, debugStack } = await executeCommand(runtime, command.command, {
      skillId: options.meta.skillId,
      publisher: options.meta.publisher,
    });
    process.stdout.write(`${text}\n`);
    if (debugStack !== undefined) {
      process.stderr.write(`${debugStack}\n`);
    }
    return exitCode;
  } catch (error) {
    if (error instanceof RuntimeError) {
      process.stdout.write(`${formatRuntimeError(error)}\n`);
      return error.exitCode;
    }
    process.stdout.write("ERROR INTERNAL\nUnexpected runtime failure.\n");
    return 1;
  }
}
