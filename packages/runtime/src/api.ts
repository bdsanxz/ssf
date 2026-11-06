// F-45/F-46: SkillRuntime with a fail-closed flow (plus F-48/49/50/51/52/56).
// Flow per protected command: loadLicense (first wins) -> core checks
// (signature, kid, expiry, scope) -> load container -> verify artifact
// signature BEFORE decrypting -> decrypt -> serve. There is no cached
// "authorized" flag: every protected command re-verifies from scratch, so a
// bypassed check in one place never opens the others (F-26). Public files
// serve without any license (F-56) and keep working after license errors.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KeyObject } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  checkOnlineScope,
  checkScope,
  contentKeyFor,
  LicenseError,
  verifyLicenseToken,
  detectClockRollback,
  readLastSeen,
  writeLastSeen,
  type LicensePayload,
} from "@ssf/license";
import { resolveOnlineContentKey } from "./online.js";
import {
  DeniedByPlugin,
  orderPlugins,
  pluginsForMode,
  runAllAllow,
  runFirstWins,
  runWaterfall,
  type LicenseRequestContext,
  type LicenseView,
  type SsfPlugin,
} from "@ssf/plugin-api";
import { createTokenKeyProvider, keyProviderLease, licenseSourceEnv, licenseSourceFile } from "@ssf/plugins";
import { isValidLogicalPath, toLogicalPath } from "@ssf/manifest";
import { buildAad, decodeTier1Text, deriveFileKey, open } from "@ssf/crypto";
import { skillStateDir, userConfigDir } from "./state.js";
import { loadContainer, verifyArtifactBeforeDecrypt } from "./container.js";
import { buildNotice, RuntimeError, formatRuntimeError, type ContractLang, type RuntimeErrorCode } from "@ssf/agent-contract";
import { runFromMemory, sanitizeRunArgs, sanitizeScriptError, type MemoryExecOptions, type MemoryExecResult } from "./exec.js";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SNIPPET_CHARS,
  MAX_LINES_PER_READ,
  paginateLines,
  splitLines,
  truncateChars,
} from "./paginate.js";
import type { ContainerEntry } from "@ssf/crypto";

// Result shapes live in @ssf/agent-contract (F-58); re-exported here so
// existing runtime consumers keep working.
import type { ListEntry, ReadResult, RunResult, SearchResult } from "@ssf/agent-contract";
export type { ListEntry, ReadResult, RunResult, SearchResult } from "@ssf/agent-contract";

export interface RuntimeLimits {
  defaultMaxLines: number;
  defaultMaxChars: number;
  defaultScriptOutputChars: number;
  defaultScriptTimeoutSeconds: number;
}

export interface RuntimeKeys {
  licensePublicKey: KeyObject;
  artifactPublicKey: KeyObject;
  artifactKid: string;
  artifactSignature: Buffer;
  /** Lease verification key; required only for online tokens (F-41). */
  leasePublicKey?: KeyObject;
}

export interface RuntimeConfig {
  skillDir: string;
  publisher: string;
  skillId: string;
  version: string;
  keys: RuntimeKeys;
  licenseEnvVar: string;
  licenseConfigFile?: string;
  licenseConfigDir?: string;
  /** Explicit token override (tests and programmatic use). */
  token?: string;
  /**
   * Online verification service base URL (F-41). Falls back to the
   * SSF_LICENSE_SERVICE_URL environment variable. Only https URLs are
   * accepted, except loopback http for local development and tests.
   */
  licenseServiceUrl?: string;
  /** Transport override for the online service call (tests and pinning). */
  licenseServiceFetch?: typeof fetch;
  /**
   * Custom plugins. Key providers run before the builtins (an explicit
   * caller token still runs first); verifiers run after the core issuance
   * checks; afterRead transforms protected companion text only.
   */
  plugins?: SsfPlugin[];
  lang?: ContractLang;
  limits?: Partial<RuntimeLimits>;
  noticeText?: string;
  noticeEnabled?: boolean;
  nowSeconds?: number;
  /** Prod filters out apply:"dev" plugins and vice versa (default prod). */
  dev?: boolean;
  stateDir?: string;
  onClockRollback?: () => void;
  runScript?: (code: string, options: MemoryExecOptions) => Promise<MemoryExecResult>;
}

export interface SkillRuntime {
  list(path?: string, options?: { scripts?: boolean }): Promise<ListEntry[]>;
  read(path: string, options?: { start?: number; limit?: number; maxChars?: number }): Promise<ReadResult>;
  search(path: string, query: string, options?: { maxResults?: number }): Promise<SearchResult[]>;
  run(scriptId: string, args?: string[]): Promise<RunResult>;
  /** Write a protected binary companion to a file (F-94). Text uses read. */
  extract(path: string, options: { outFile: string }): Promise<ExtractResult>;
  /** True when a license is present; other license errors throw. */
  checkAccess(): Promise<{ licensed: boolean }>;
  formatError(error: unknown): { text: string; exitCode: number };
}

export interface ExtractResult {
  outFile: string;
  bytes: number;
}

interface Authorized {
  payload: LicensePayload;
  license: LicenseView;
  contentKey: Buffer;
  entries: ContainerEntry[];
  protectedById: Map<string, ContainerEntry>;
}

interface PublicFile {
  path: string;
  description?: string;
}

const DEFAULT_LIMITS: RuntimeLimits = {
  defaultMaxLines: MAX_LINES_PER_READ,
  defaultMaxChars: DEFAULT_MAX_CHARS,
  defaultScriptOutputChars: 20000,
  defaultScriptTimeoutSeconds: 120,
};

function toRuntimeError(error: unknown, fallback: RuntimeErrorCode): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }
  if (error instanceof LicenseError) {
    return new RuntimeError(error.code, error.message);
  }
  return new RuntimeError(fallback, error instanceof Error ? error.message : "License key is not valid.");
}

export function createRuntime(config: RuntimeConfig): SkillRuntime {
  const limits: RuntimeLimits = { ...DEFAULT_LIMITS, ...config.limits };
  const stateDir = config.stateDir ?? skillStateDir(userConfigDir(), config.publisher, config.skillId);
  const nowSeconds = config.nowSeconds ?? Math.floor(Date.now() / 1000);
  const noticeEnabled = config.noticeEnabled ?? true;

  function readPackageManifest(): { companion_files?: PublicFile[] } {
    try {
      const raw = readFileSync(join(config.skillDir, "skill.manifest"), "utf8");
      return parseYaml(raw) as { companion_files?: PublicFile[] };
    } catch {
      return {};
    }
  }

  function publicFiles(): PublicFile[] {
    return readPackageManifest().companion_files ?? [];
  }

  function isPublicPath(path: string): boolean {
    return publicFiles().some((file) => file.path === path);
  }

  /**
   * F-86: normalize caller-supplied paths before any validation or lookup.
   * Windows backslashes become forward slashes so `secrets\notes.md`
   * serves; traversal stays rejected because `..\x` normalizes to `../x`,
   * which is not a valid logical path and matches no entry.
   */
  function normalizeInputPath(value: string): string {
    return toLogicalPath(value);
  }

  /** Reject anything that is not a concrete logical file or script id. */
  function requireLogicalPath(value: string, what: string): string {
    const logical = normalizeInputPath(value);
    if (!isValidLogicalPath(logical)) {
      throw new RuntimeError("PATH_NOT_FOUND", `Unknown ${what}: ${value}. Check the id or path with list.`);
    }
    return logical;
  }

  /** True when an id equals the prefix or lives under it (trailing / tolerated). */
  function matchesScope(id: string, prefix: string | null): boolean {
    if (prefix === null || prefix === "") {
      return true;
    }
    const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    return id === clean || id.startsWith(`${clean}/`);
  }

  /**
   * F-26/F-63: every protected command re-verifies license, container, and
   * signature. Key loading flows through the hook runner in first-wins
   * rounds: explicit caller token (token-first), loadLicense sources
   * (customs plus the license-source-env/file builtins), then provideKey
   * plugins plus the key-provider-lease slot. Core issuance checks follow;
   * custom verifyLicense hooks run after them as extra policy (deny beats
   * allow). Installed runtimes carry no custom plugins: with an empty list
   * the same runner still drives the builtins (F-67).
   */
  function licenseContext(): LicenseRequestContext {
    return {
      publisher: config.publisher,
      skillId: config.skillId,
      version: config.version,
      lang: config.lang ?? "en",
      envVar: config.licenseEnvVar,
      configFile: config.licenseConfigFile ?? "license",
      configDir: config.licenseConfigDir,
      hasProvidedToken: config.token !== undefined,
    };
  }

  /** Custom plugins in enforce order, filtered to the current dev/prod mode. */
  function orderedCustom(): SsfPlugin[] {
    const mode = config.dev === true ? "dev" : "prod";
    return pluginsForMode(orderPlugins(config.plugins ?? []), mode);
  }

  /**
   * Key loading in three first-wins rounds: an explicitly passed caller
   * token first (key-provider-token, token-first), then license sources
   * (custom keychain/secret-manager/SSO plugins followed by the
   * license-source-env/file builtins), then key providers (custom plus the
   * key-provider-lease slot, dormant until online mode F-41). All defaults
   * flow through the hook runner like any other plugin (F-67).
   */
  async function loadKeyMaterial(context: LicenseRequestContext): Promise<{ plugin: string; value: string }> {
    if (config.token !== undefined) {
      const provider = createTokenKeyProvider(config.token);
      const hit = await runFirstWins([provider], "runtime.provideKey", context, (candidate, hookContext) =>
        candidate.runtime!.provideKey!(hookContext),
      );
      if (hit) {
        return hit;
      }
    }
    const customs = orderedCustom();
    const loaders = [...customs.filter((entry) => entry.runtime?.loadLicense), licenseSourceEnv, licenseSourceFile];
    {
      const hit = await runFirstWins(loaders, "runtime.loadLicense", context, (candidate, hookContext) =>
        candidate.runtime!.loadLicense!(hookContext),
      );
      if (hit) {
        return hit;
      }
    }
    const providers = [...customs.filter((entry) => entry.runtime?.provideKey), keyProviderLease];
    const hit = await runFirstWins(providers, "runtime.provideKey", context, (candidate, hookContext) =>
      candidate.runtime!.provideKey!(hookContext),
    );
    if (!hit) {
      throw new RuntimeError(
        "LICENSE_MISSING",
        `Set a license key in ${config.licenseEnvVar} or the user config file.`,
      );
    }
    return hit;
  }

  /**
   * F-64: afterRead transforms protected companion text only. Scripts never
   * pass through here (run() decrypts separately) and public files skip the
   * waterfall, so script source stays unreachable.
   */
  async function applyAfterRead(fileId: string, text: string, license: LicenseView): Promise<string> {
    const hooks = orderedCustom().filter((entry) => entry.runtime?.afterRead);
    if (hooks.length === 0) {
      return text;
    }
    return runWaterfall(
      hooks,
      "runtime.afterRead",
      {
        publisher: config.publisher,
        skillId: config.skillId,
        version: config.version,
        lang: config.lang ?? "en",
        fileId,
        license,
      },
      text,
      (plugin, hookContext, current) => plugin.runtime!.afterRead!(hookContext, current),
    );
  }

  async function authorize(): Promise<Authorized> {
    const context = licenseContext();
    const found = await loadKeyMaterial(context);
    let payload: LicensePayload;
    try {
      payload = verifyLicenseToken(found.value, {
        licensePublicKey: config.keys.licensePublicKey,
        expectedPublisher: config.publisher,
        nowSeconds,
        dev: config.dev === true,
      });
    } catch (error) {
      throw toRuntimeError(error, "LICENSE_INVALID");
    }
    let contentKey: Buffer;
    if (payload.mode === "online") {
      try {
        checkOnlineScope(payload, { skillId: config.skillId, version: config.version });
      } catch (error) {
        throw toRuntimeError(error, "LICENSE_SCOPE");
      }
      contentKey = await authorizeOnline(payload, found.value);
    } else {
      try {
        checkScope(payload, { skillId: config.skillId, version: config.version });
      } catch (error) {
        throw toRuntimeError(error, "LICENSE_SCOPE");
      }
      contentKey = contentKeyFor(payload, { skillId: config.skillId, version: config.version });
    }
    const license: LicenseView = {
      license_id: payload.license_id,
      publisher: payload.publisher,
      mode: payload.mode,
      skills: payload.skills,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      ext: payload.ext,
    };
    const verifiers = orderedCustom().filter((entry) => entry.runtime?.verifyLicense);
    if (verifiers.length > 0) {
      await runAllAllow(
        verifiers,
        "runtime.verifyLicense",
        {
          ...context,
          license,
          deny: (code: string, message: string): never => {
            throw new DeniedByPlugin(code, message);
          },
        },
        (plugin, hookContext) => plugin.runtime!.verifyLicense!(hookContext),
      );
    }
    const container = loadContainer(join(config.skillDir, "scripts", "runtime.bin"));
    verifyArtifactBeforeDecrypt(config.keys.artifactPublicKey, container, config.keys.artifactSignature);
    try {
      const seen = readLastSeen(stateDir);
      if (detectClockRollback(seen, nowSeconds)) {
        config.onClockRollback?.();
      }
      writeLastSeen(stateDir, Math.max(seen ?? nowSeconds, nowSeconds));
    } catch {
      // last_seen is best effort only
    }
    return {
      payload,
      license,
      contentKey,
      entries: container.entries,
      protectedById: new Map(container.entries.map((entry) => [entry.id, entry])),
    };
  }

  /**
   * F-41: resolve the content key for an online token through the lease
   * cache or the verification service. Missing lease key or service URL
   * fails closed; transport and service errors keep their codes.
   */
  async function authorizeOnline(payload: LicensePayload, token: string): Promise<Buffer> {
    if (!config.keys.leasePublicKey) {
      throw new RuntimeError("LICENSE_INVALID", "Online license needs a lease public key in the runtime keys.");
    }
    const serviceUrl = config.licenseServiceUrl ?? process.env["SSF_LICENSE_SERVICE_URL"] ?? "";
    if (serviceUrl.length === 0) {
      throw new RuntimeError(
        "NETWORK_UNAVAILABLE",
        "Online license needs a verification service URL (licenseServiceUrl or SSF_LICENSE_SERVICE_URL).",
      );
    }
    try {
      return await resolveOnlineContentKey({
        payload,
        token,
        skillId: config.skillId,
        version: config.version,
        serviceUrl,
        leasePublicKey: config.keys.leasePublicKey,
        stateDir,
        nowSeconds,
        fetchFn: config.licenseServiceFetch,
      });
    } catch (error) {
      throw toRuntimeError(error, "NETWORK_UNAVAILABLE");
    }
  }

  function decryptEntry(auth: Authorized, entry: ContainerEntry): Buffer {
    const fileKey = deriveFileKey(auth.contentKey, entry.id);
    const aad = buildAad(config.skillId, config.version, entry.id);
    try {
      return open(fileKey, entry.nonce, entry.ciphertext, entry.tag, aad);
    } catch {
      throw new RuntimeError("ARTIFACT_INVALID", "Protected content failed authentication.");
    }
  }

  /**
   * Decode a decrypted companion to agent-facing text. Obfuscated entries
   * are tier-1-encoded at rest; a missing or corrupt prefix fails closed so
   * a tampered or plugin-stripped payload never serves as plain text.
   * Binary entries are extract-only: they never decode as text here.
   */
  function decodeEntryText(entry: ContainerEntry, bytes: Buffer): string {
    if (entry.binary === true) {
      throw new RuntimeError("NOT_READABLE", `Binary file "${entry.id}" cannot be read as text. Extract it instead.`);
    }
    if (entry.protection !== "obfuscated") {
      return bytes.toString("utf8");
    }
    try {
      return decodeTier1Text(bytes.toString("utf8"));
    } catch {
      throw new RuntimeError("ARTIFACT_INVALID", "Protected content failed authentication.");
    }
  }

  function readPublicFile(path: string, start: number, limit: number, maxChars: number): ReadResult {
    let text: string;
    try {
      const full = join(config.skillDir, path);
      if (!statSync(full).isFile()) {
        throw new RuntimeError("PATH_NOT_FOUND", `Unknown path: ${path}. Check the id or path with list.`);
      }
      text = readFileSync(full, "utf8");
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError("PATH_NOT_FOUND", `Unknown path: ${path}. Check the id or path with list.`);
    }
    return paginateContent(text, start, limit, maxChars, false);
  }

  function paginateContent(
    text: string,
    start: number,
    limit: number,
    maxChars: number,
    isProtected: boolean,
  ): ReadResult {
    const page = paginateLines(splitLines(text), start, Math.min(limit, limits.defaultMaxLines));
    const cut = truncateChars(page.content, maxChars);
    return {
      content: cut.text,
      start: page.start,
      end: page.end,
      totalLines: page.totalLines,
      truncated: page.truncated || cut.truncated,
      nextStart: page.nextStart,
      isProtected,
    };
  }

  const runtime: SkillRuntime = {
    async checkAccess(): Promise<{ licensed: boolean }> {
      try {
        await authorize();
        return { licensed: true };
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "LICENSE_MISSING") {
          return { licensed: false };
        }
        throw error;
      }
    },
    async list(path?: string, options?: { scripts?: boolean }): Promise<ListEntry[]> {
      if (options?.scripts) {
        const auth = await authorize();
        return auth.entries
          .filter((entry) => entry.kind === "script")
          .map((entry) => ({ id: entry.id, kind: "script" as const, visibility: "protected" as const, description: entry.description, usage: entry.usage }));
      }
      const prefix = path === undefined || path === "" ? null : normalizeInputPath(path);
      const listed: ListEntry[] = publicFiles()
        .filter((file) => matchesScope(file.path, prefix))
        .map((file) => ({ id: file.path, kind: "file" as const, visibility: "public" as const, description: file.description }));
      let auth: Authorized | null = null;
      try {
        auth = await authorize();
      } catch (error) {
        if (error instanceof RuntimeError && error.code === "LICENSE_MISSING") {
          return listed;
        }
        throw error;
      }
      for (const entry of auth.entries) {
        if (entry.kind !== "file") continue;
        if (!matchesScope(entry.id, prefix)) continue;
        listed.push({
          id: entry.id,
          kind: "file",
          visibility: "protected",
          lines: entry.lines,
          description: entry.description,
        });
      }
      if (prefix === null) {
        for (const entry of auth.entries) {
          if (entry.kind !== "script") continue;
          listed.push({
            id: entry.id,
            kind: "script",
            visibility: "protected",
            description: entry.description,
            usage: entry.usage,
          });
        }
      }
      return listed;
    },

    async read(path: string, options?: { start?: number; limit?: number; maxChars?: number }): Promise<ReadResult> {
      const start = options?.start ?? 1;
      const limit = options?.limit ?? limits.defaultMaxLines;
      const maxChars = options?.maxChars ?? limits.defaultMaxChars;
      const logical = requireLogicalPath(path, "path");
      if (isPublicPath(logical)) {
        const result = readPublicFile(logical, start, limit, maxChars);
        return { ...result, isProtected: false };
      }
      const auth = await authorize();
      const entry = auth.protectedById.get(logical);
      if (!entry) {
        throw new RuntimeError("PATH_NOT_FOUND", `Unknown path: ${path}. Check the id or path with list.`);
      }
      if (entry.kind === "script") {
        throw new RuntimeError("NOT_READABLE", "Scripts only run with run; see usage with list --scripts.");
      }
      const text = decodeEntryText(entry, decryptEntry(auth, entry));
      // Proposal 12.4/F-65: limits apply to the content AFTER afterRead, so
      // a watermarking hook cannot smuggle extra text past the budget. The
      // header and notice are added by the outer layer afterwards: they do
      // not count against the line budget, but the notice DOES count against
      // the character budget, so its length is reserved here. The outer
      // layer prepends exactly buildNotice(publisher, noticeText) when the
      // same notice settings are configured there (always true for the
      // shipped installed runtime, which sets neither).
      const hooked = await applyAfterRead(logical, text, auth.license);
      const reserved = noticeEnabled
        ? Array.from(buildNotice(config.publisher, config.noticeText)).length + "\n---\n".length
        : 0;
      const capped = paginateContent(
        hooked,
        start,
        Math.min(limit, entry.maxLines ?? limits.defaultMaxLines),
        Math.max(0, Math.min(maxChars, entry.maxChars ?? limits.defaultMaxChars) - reserved),
        true,
      );
      return capped;
    },

    async search(path: string, query: string, options?: { maxResults?: number }): Promise<SearchResult[]> {
      if (!query) {
        return [];
      }
      const maxResults = Math.min(options?.maxResults ?? DEFAULT_SEARCH_RESULTS, 100);
      const prefix = path === "" ? null : normalizeInputPath(path);
      const candidates: Array<{ id: string; text: string; isProtected: boolean }> = [];
      for (const file of publicFiles()) {
        if (!matchesScope(file.path, prefix)) continue;
        try {
          candidates.push({ id: file.path, text: readFileSync(join(config.skillDir, file.path), "utf8"), isProtected: false });
        } catch {
          continue;
        }
      }
      // Protected scope needs a license. Without one, public-only results
      // serve; an unmatched prefix fails closed through authorize().
      let auth: Authorized | null = null;
      if (prefix === null) {
        try {
          auth = await authorize();
        } catch (error) {
          if (!(error instanceof RuntimeError && error.code === "LICENSE_MISSING")) {
            throw error;
          }
        }
      } else if (candidates.length === 0) {
        auth = await authorize();
      }
      if (auth) {
        const exact = prefix === null ? undefined : auth.protectedById.get(prefix);
        if (exact && exact.kind === "script") {
          throw new RuntimeError("NOT_READABLE", "Scripts only run with run; see usage with list --scripts.");
        }
        if (exact && exact.kind === "file" && exact.binary === true) {
          throw new RuntimeError("NOT_READABLE", `Binary file "${prefix}" cannot be searched as text. Extract it instead.`);
        }
        for (const entry of auth.entries) {
          if (entry.kind !== "file" || entry.binary === true || !matchesScope(entry.id, prefix)) continue;
          if (candidates.some((candidate) => candidate.id === entry.id)) continue;
          candidates.push({ id: entry.id, text: decodeEntryText(entry, decryptEntry(auth, entry)), isProtected: true });
        }
        if (prefix !== null && !exact && !candidates.some((candidate) => matchesScope(candidate.id, prefix))) {
          throw new RuntimeError("PATH_NOT_FOUND", `Unknown path: ${path}. Check the id or path with list.`);
        }
      } else if (prefix !== null && candidates.length === 0) {
        await authorize();
      }
      const needle = query.toLowerCase();
      const results: SearchResult[] = [];
      for (const candidate of candidates) {
        const lines = splitLines(candidate.text);
        for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
          const line = lines[i] as string;
          const at = line.toLowerCase().indexOf(needle);
          if (at === -1) continue;
          // Protected candidates only exist with an authorized session, so
          // the license view is always present for watermarking here.
          const snippet =
            candidate.isProtected && auth
              ? await applyAfterRead(candidate.id, snippetAround(line, at), auth.license)
              : snippetAround(line, at);
          results.push({ path: candidate.id, line: i + 1, snippet, isProtected: candidate.isProtected });
        }
        if (results.length >= maxResults) break;
      }
      return results;
    },

    /**
     * F-94: write a protected binary companion to a file. Text companions
     * use read; scripts use run. Watermarking and pagination are text
     * stages, so extract serves raw decrypted bytes with no transform.
     */
    async extract(path: string, options: { outFile: string }): Promise<ExtractResult> {
      const logical = requireLogicalPath(path, "path");
      if (isPublicPath(logical)) {
        throw new RuntimeError("NOT_READABLE", `Public file "${path}" needs no license; copy it directly.`);
      }
      const auth = await authorize();
      const entry = auth.protectedById.get(logical);
      if (!entry) {
        throw new RuntimeError("PATH_NOT_FOUND", `Unknown path: ${path}. Check the id or path with list.`);
      }
      if (entry.kind === "script") {
        throw new RuntimeError("NOT_READABLE", "Scripts only run with run; see usage with list --scripts.");
      }
      if (entry.binary !== true) {
        throw new RuntimeError("NOT_READABLE", `Text file "${path}" reads with read; extract is for binary files.`);
      }
      if (options.outFile.trim().length === 0) {
        throw new RuntimeError("PATH_NOT_FOUND", "extract needs an output file (--out).");
      }
      const bytes = decryptEntry(auth, entry);
      mkdirSync(dirname(options.outFile), { recursive: true });
      writeFileSync(options.outFile, bytes);
      return { outFile: options.outFile, bytes: bytes.length };
    },

    async run(scriptId: string, args: string[] = []): Promise<RunResult> {
      const logicalId = requireLogicalPath(scriptId, "script id");
      const auth = await authorize();
      const entry = auth.protectedById.get(logicalId);
      if (!entry || entry.kind !== "script") {
        throw new RuntimeError("PATH_NOT_FOUND", `Unknown script id: ${scriptId}. Check the id with list --scripts.`);
      }
      const code = decryptEntry(auth, entry).toString("utf8");
      const timeoutMs = (entry.timeoutSeconds ?? limits.defaultScriptTimeoutSeconds) * 1000;
      const maxChars = entry.maxOutputChars ?? limits.defaultScriptOutputChars;
      const exec = config.runScript ?? runFromMemory;
      const result = await exec(code, { args: sanitizeRunArgs(args), timeoutMs, maxChars, cwd: config.skillDir });
      if (result.timedOut) {
        throw new RuntimeError("SCRIPT_TIMEOUT", "The operation timed out; try a smaller input.");
      }
      const stdout = result.stdout;
      const stderr = sanitizeScriptError(result.stderr);
      const chars = Array.from(stdout).length + Array.from(stderr).length;
      return { exitCode: result.exitCode ?? 1, stdout, stderr, chars, truncated: result.truncated };
    },

    formatError(error: unknown): { text: string; exitCode: number } {
      if (error instanceof RuntimeError) {
        return { text: formatRuntimeError(error), exitCode: error.exitCode };
      }
      return { text: "ERROR INTERNAL\nUnexpected runtime failure.", exitCode: 1 };
    },
  };
  return runtime;
}

function snippetAround(line: string, at: number): string {
  const budget = DEFAULT_SNIPPET_CHARS;
  const trimmed = line.trim();
  const points = Array.from(trimmed);
  if (points.length <= budget) {
    return trimmed;
  }
  const leadingSpaces = line.length - line.trimStart().length;
  const matchInTrimmed = Math.max(0, at - leadingSpaces);
  const half = Math.floor(budget / 2);
  const start = Math.max(0, Math.min(matchInTrimmed - half, points.length - budget));
  return `${start > 0 ? "..." : ""}${points.slice(start, start + budget).join("")}${start + budget < points.length ? "..." : ""}`;
}
