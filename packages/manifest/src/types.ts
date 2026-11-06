// Shared types for workspace config (ssf.config.ts) and skill manifests.
// Sprint 1 foundation only: parsing and basic validation, no crypto or build.

export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const MAX_COMPATIBILITY_LENGTH = 500;
export const MAX_LINES_PER_FILE = 500;

export type LicenseMode = "offline" | "online";
export type Protection = "none" | "obfuscated" | "encrypted";

export interface ConfidentialityNoticeConfig {
  enabled: boolean;
  text?: string;
}

export interface SsfConfig {
  workspace: {
    publisher: string;
    defaultMode: LicenseMode;
  };
  license: {
    env: string;
    configFile: string;
  };
  keys: {
    dir: string;
    licenseKid: string;
    artifactKid: string;
    rootKid: string;
    /** Lease signing kid; enables online leases in builds when set. */
    leaseKid?: string;
  };
  limits: {
    defaultMaxLines: number;
    defaultMaxChars: number;
    defaultScriptOutputChars: number;
    defaultScriptTimeoutSeconds: number;
  };
  agent: {
    confidentialityNotice: ConfidentialityNoticeConfig;
    allowedTools?: string;
  };
  build: {
    obfuscate: { scripts: boolean; runtime: boolean };
    diversify: boolean;
  };
  skills: string[];
  plugins: string[];
}

export interface SharedEntry {
  path: string;
}

export interface CompanionFileEntry {
  path: string;
  protection?: Protection;
  description?: string;
  max_lines?: number;
  max_chars?: number;
  confidentiality_notice?: boolean;
}

export interface ScriptEntry {
  id: string;
  entry: string;
  description: string;
  usage: string;
  max_output_chars?: number;
  timeout_seconds?: number;
}

export interface SkillManifest {
  skill: {
    id: string;
    version: string;
    description: string;
    license?: string;
    metadata?: Record<string, string>;
  };
  license?: {
    mode?: LicenseMode;
  };
  limits?: {
    default_max_lines?: number;
    default_max_chars?: number;
  };
  shared?: SharedEntry[];
  companion_files?: CompanionFileEntry[];
  scripts?: ScriptEntry[];
  exclude?: string[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}
