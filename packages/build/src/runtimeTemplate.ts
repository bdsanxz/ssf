// Real runtime loader source (Sprint 5).
// The bundled scripts/runtime.js imports the installed entry point and runs
// it with metadata embedded at build time: skill identity, the license env
// var, production public keys, the artifact kid and signature, and the seed
// material. The container still resolves next to the runtime file itself.
// F-25b4: the metadata key order is shuffled by the release seed, so the
// initialization data varies structurally per seed (parsing is order-free).

import { CONTAINER_FORMAT_SEEDED } from "@ssf/crypto";

export interface RuntimeLoaderMeta {
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
  /** Builtin runtime plugin names embedded for installed.ts to resolve. */
  pluginNames: string[];
  /** True for dev builds (kid dev); production runtimes never set this. */
  dev: boolean;
  /** Container layout the release was built with (F-16b3, F-25). */
  containerLayout: number;
  installedEntryFile: string;
}

/** Seed-driven key shuffle (Fisher-Yates over xorshift32): init order varies per seed. */
export function shuffleKeysBySeed<T extends Record<string, unknown>>(value: T, seedHex: string): T {
  let state = parseInt(seedHex.slice(0, 8), 16);
  if (!Number.isInteger(state) || state === 0) {
    state = 0x9e3779b9;
  }
  const next = (): number => {
    state ^= (state << 13) >>> 0;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= (state << 5) >>> 0;
    state >>>= 0;
    return state / 0x100000000;
  };
  const keys = Object.keys(value);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const current = keys[i] as string;
    keys[i] = keys[j] as string;
    keys[j] = current;
  }
  const out = {} as T;
  for (const key of keys) {
    out[key as keyof T] = value[key as keyof T];
  }
  return out;
}

/** Render the runtime.js entry source before bundling. */
export function renderRuntimeSource(meta: RuntimeLoaderMeta): string {
  const ordered = shuffleKeysBySeed(
    {
      skillId: meta.skillId,
      version: meta.version,
      publisher: meta.publisher,
      licenseEnvVar: meta.licenseEnvVar,
      licensePublicKeyPem: meta.licensePublicKeyPem,
      leasePublicKeyPem: meta.leasePublicKeyPem,
      artifactPublicKeyPem: meta.artifactPublicKeyPem,
      artifactKid: meta.artifactKid,
      artifactSignatureHex: meta.artifactSignatureHex,
      seedHex: meta.seedHex,
      pluginNames: meta.pluginNames,
      dev: meta.dev,
      containerLayout: meta.containerLayout,
    },
    meta.seedHex,
  );
  const encoded = JSON.stringify(ordered);
  return (
    `"use strict";\n` +
    `const { runInstalled } = require(${JSON.stringify(meta.installedEntryFile)});\n` +
    `const meta = ${encoded};\n` +
    `runInstalled({ runtimeJsPath: __filename, meta, argv: process.argv.slice(2), env: process.env })\n` +
    `  .then((code) => { process.exitCode = code; })\n` +
    `  .catch((error) => { process.stdout.write("ERROR INTERNAL\\nUnexpected runtime failure.\\n"); process.exitCode = 1; void error; });\n`
  );
}
