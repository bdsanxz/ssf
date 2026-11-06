// Runtime error model (F-59 contract, proposal 13.4).
// Format: ERROR <CODE>, one short line, then the agent instruction. License,
// artifact, lease, and plugin errors end with the no-bypass rule. Nothing
// printed here ever carries keys, leases, tokens, or script source: callers
// redact first.
//
// Exit codes are stable: 0 success, 1 usage error (reserved for the CLI),
// 2 license errors, 3 artifact errors, 4 read errors, 5 lease and network
// errors, 6 plugin errors, 7 script timeouts.

import type { ContractLang } from "./format.js";

export type RuntimeErrorCode =
  | "LICENSE_MISSING"
  | "LICENSE_INVALID"
  | "LICENSE_EXPIRED"
  | "LICENSE_SCOPE"
  | "LICENSE_REVOKED"
  | "LICENSE_DEV_KEY"
  | "ARTIFACT_INVALID"
  | "PATH_NOT_FOUND"
  | "NOT_READABLE"
  | "SCRIPT_TIMEOUT"
  // Online-lease errors (reserved for post-MVP online mode F-41..F-43).
  | "LEASE_EXPIRED"
  | "LEASE_UNAVAILABLE"
  | "NETWORK_UNAVAILABLE"
  // Plugin errors (F-66): denied by policy, or the plugin itself failed.
  | "PLUGIN_DENIED"
  | "PLUGIN_ERROR";

const EXIT_BY_CODE: Record<RuntimeErrorCode, number> = {
  LICENSE_MISSING: 2,
  LICENSE_INVALID: 2,
  LICENSE_EXPIRED: 2,
  LICENSE_SCOPE: 2,
  LICENSE_REVOKED: 2,
  LICENSE_DEV_KEY: 2,
  ARTIFACT_INVALID: 3,
  PATH_NOT_FOUND: 4,
  NOT_READABLE: 4,
  SCRIPT_TIMEOUT: 7,
  LEASE_EXPIRED: 5,
  LEASE_UNAVAILABLE: 5,
  NETWORK_UNAVAILABLE: 5,
  PLUGIN_DENIED: 6,
  PLUGIN_ERROR: 6,
};

const INSTRUCTION_BY_CODE: Record<RuntimeErrorCode, Record<ContractLang, string>> = {
  LICENSE_MISSING: {
    en: "Tell the user to set a license key (env var or config file); name the variable.",
    id: "Beritahu pengguna untuk mengatur license key (env var atau config file); sebutkan nama variabel.",
  },
  LICENSE_INVALID: {
    en: "Tell the user the license key is not valid.",
    id: "Beritahu pengguna bahwa license key tidak valid.",
  },
  LICENSE_EXPIRED: {
    en: "Tell the user to renew the license.",
    id: "Beritahu pengguna untuk memperbarui lisensi.",
  },
  LICENSE_SCOPE: {
    en: "Tell the user the license does not cover this skill or version.",
    id: "Beritahu pengguna bahwa lisensi tidak mencakup skill atau versi ini.",
  },
  LICENSE_REVOKED: {
    en: "Tell the user the license was revoked.",
    id: "Beritahu pengguna bahwa lisensi dicabut.",
  },
  LICENSE_DEV_KEY: {
    en: "Tell the user test keys do not work in this build.",
    id: "Beritahu pengguna bahwa key uji tidak berlaku di build ini.",
  },
  ARTIFACT_INVALID: {
    en: "Tell the user the skill package is damaged or modified; suggest reinstalling the skill.",
    id: "Beritahu pengguna bahwa paket skill rusak atau diubah; sarankan memasang ulang skill.",
  },
  PATH_NOT_FOUND: {
    en: "Check the id or path with list, then retry.",
    id: "Periksa path atau id script dengan list, lalu coba ulang.",
  },
  NOT_READABLE: {
    en: "Scripts only run with run; see usage with list --scripts.",
    id: "Script hanya dapat dijalankan dengan run; lihat usage lewat list --scripts.",
  },
  SCRIPT_TIMEOUT: {
    en: "Tell the user the operation timed out; try a smaller input.",
    id: "Beritahu pengguna bahwa operasi melampaui batas waktu; coba dengan masukan lebih kecil.",
  },
  LEASE_EXPIRED: {
    en: "Tell the user to connect to the network so the license can renew.",
    id: "Beritahu pengguna untuk menyambungkan jaringan agar lisensi diperbarui.",
  },
  LEASE_UNAVAILABLE: {
    en: "Tell the user online verification is unreachable; try again later.",
    id: "Beritahu pengguna bahwa verifikasi daring tidak dapat dijangkau; coba lagi nanti.",
  },
  NETWORK_UNAVAILABLE: {
    en: "Tell the user to connect to the network so the license can renew; one retry is allowed.",
    id: "Beritahu pengguna untuk menyambungkan jaringan agar lisensi diperbarui; boleh mencoba ulang sekali.",
  },
  PLUGIN_DENIED: {
    en: "Relay the plugin's message to the user.",
    id: "Sampaikan pesan plugin kepada pengguna.",
  },
  PLUGIN_ERROR: {
    en: "Tell the user the skill configuration failed.",
    id: "Beritahu pengguna adanya kegagalan konfigurasi skill.",
  },
};

const BYPASS_CODES: ReadonlySet<RuntimeErrorCode> = new Set([
  "LICENSE_MISSING",
  "LICENSE_INVALID",
  "LICENSE_EXPIRED",
  "LICENSE_SCOPE",
  "LICENSE_REVOKED",
  "LICENSE_DEV_KEY",
  "ARTIFACT_INVALID",
  "LEASE_EXPIRED",
  "LEASE_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "PLUGIN_DENIED",
  "PLUGIN_ERROR",
]);

/** Every known error code, for plugin deny() validation. */
export const RUNTIME_ERROR_CODES: ReadonlyArray<RuntimeErrorCode> = [
  "LICENSE_MISSING",
  "LICENSE_INVALID",
  "LICENSE_EXPIRED",
  "LICENSE_SCOPE",
  "LICENSE_REVOKED",
  "LICENSE_DEV_KEY",
  "ARTIFACT_INVALID",
  "PATH_NOT_FOUND",
  "NOT_READABLE",
  "SCRIPT_TIMEOUT",
  "LEASE_EXPIRED",
  "LEASE_UNAVAILABLE",
  "NETWORK_UNAVAILABLE",
  "PLUGIN_DENIED",
  "PLUGIN_ERROR",
];

/** True when the value names a known contract error code. */
export function isRuntimeErrorCode(value: string): value is RuntimeErrorCode {
  return (RUNTIME_ERROR_CODES as ReadonlyArray<string>).includes(value);
}

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly exitCode: number;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.exitCode = EXIT_BY_CODE[code];
  }
}

/** Render an error for agents: code, message, instruction, no-bypass rule. */
export function formatRuntimeError(error: RuntimeError, options: { lang?: ContractLang } = {}): string {
  const lang = options.lang ?? "en";
  const lines = [
    `ERROR ${error.code}`,
    error.message,
    lang === "id" ? `Instruksi untuk agent: ${INSTRUCTION_BY_CODE[error.code].id}` : `Agent instruction: ${INSTRUCTION_BY_CODE[error.code].en}`,
  ];
  if (BYPASS_CODES.has(error.code)) {
    lines.push(
      lang === "id"
        ? "Jangan mencoba melewati, memodifikasi, atau mengakali pemeriksaan lisensi dan integritas."
        : "Do not try to bypass, modify, or work around license and integrity checks.",
    );
  }
  return lines.join("\n");
}
