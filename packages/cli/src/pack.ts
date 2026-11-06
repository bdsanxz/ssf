// F-77: distribution packing (`ssf pack`) and unpacking (`ssf unpack`).
// A pack is a deterministic gzip-compressed ustar archive (`.tgz`) holding
// exactly the built package directory: no sources, no keys, no extra
// files. Only public level-0 skills pack: dev/test-kid containers and any
// protected entry (companions and scripts are never `none`) are refused.
// Every byte of the archive is tamper-evident: gzip CRC covers the whole
// stream, tar header checksums cover the structure, and the container
// integrity hash plus the layout check cover the content. Any failure at
// unpack fails with ARTIFACT_TAMPERED. Errors are CLI-side PackErrors with
// stable codes; they never extend the agent-facing error contract (F-59).

import { gunzipSync, gzipSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { decodeContainer, isTestKid } from "@ssf/crypto";
import { parseSkillManifestText } from "@ssf/manifest";
import { validateDistribution } from "@ssf/skills-compat";

export type PackErrorCode =
  | "BUILD_DEV_PACK_REFUSED"
  | "BUILD_TIER_PACK_REFUSED"
  | "BUILD_LAYOUT_PACK_REFUSED"
  | "BUILD_FILE_EXISTS"
  | "ARTIFACT_TAMPERED";

/** CLI-side pack/unpack failure with a stable machine-readable code. */
export class PackError extends Error {
  readonly code: PackErrorCode;

  constructor(code: PackErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PackError";
    this.code = code;
  }
}

interface TarEntry {
  path: string;
  data: Buffer;
  dir: boolean;
}

function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const text = `${value.toString(8).padStart(length - 1, "0")}\0`;
  header.write(text, offset, length, "ascii");
}

/** Minimal deterministic ustar writer: fixed mtime/uid/gid, sorted entries. */
export function tarCreate(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const ordered = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of ordered) {
    const header = Buffer.alloc(512, 0);
    const parts = entry.path.split("/");
    const name = parts.pop() ?? "";
    const prefix = parts.join("/");
    if (Buffer.byteLength(name, "utf8") > 100 || Buffer.byteLength(prefix, "utf8") > 155) {
      throw new Error(`Path too long for ustar: ${entry.path}`);
    }
    header.write(name, 0, 100, "utf8");
    writeOctal(header, 100, 8, entry.dir ? 0o755 : 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.dir ? 0 : entry.data.length);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.dir ? "5" : "0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (prefix.length > 0) {
      header.write(prefix, 345, 155, "utf8");
    }
    let sum = 0;
    for (const byte of header) {
      sum += byte;
    }
    writeOctal(header, 148, 8, sum);
    blocks.push(header);
    if (!entry.dir) {
      blocks.push(entry.data);
      const remainder = entry.data.length % 512;
      if (remainder !== 0) {
        blocks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** Minimal ustar reader: verifies checksums, rejects unsafe or odd entries. */
export function tarExtract(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 512 > archive.length) {
      throw new PackError("ARTIFACT_TAMPERED", "Archive is truncated.");
    }
    const header = archive.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) {
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    }
    const recorded = Number.parseInt(header.subarray(148, 156).toString("ascii").replace(/\0.*$/, "").trim() || "0", 8);
    if (!Number.isInteger(recorded) || recorded !== sum) {
      throw new PackError("ARTIFACT_TAMPERED", "Archive header checksum mismatch.");
    }
    const readString = (start: number, end: number): string => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    const prefix = readString(345, 500);
    const name = readString(0, 100);
    const path = prefix.length > 0 ? `${prefix}/${name}` : name;
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const size = Number.parseInt(readString(124, 136).trim() || "0", 8);
    if (!Number.isInteger(size) || size < 0 || offset + size > archive.length) {
      throw new PackError("ARTIFACT_TAMPERED", "Archive entry has an invalid size.");
    }
    if (path.length === 0 || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new PackError("ARTIFACT_TAMPERED", "Archive entry escapes the package directory.");
    }
    if (typeflag === "5") {
      entries.push({ path, data: Buffer.alloc(0), dir: true });
    } else if (typeflag === "0" || typeflag === "\0") {
      entries.push({ path, data: Buffer.from(archive.subarray(offset, offset + size)), dir: false });
      offset += Math.ceil(size / 512) * 512;
    } else {
      throw new PackError("ARTIFACT_TAMPERED", `Archive entry type is not supported: ${path}`);
    }
  }
  return entries;
}

/** Deterministic gzip: zero the MTIME field so identical inputs compress identically. */
export function tgzCompress(tar: Buffer): Buffer {
  const out = Buffer.from(gzipSync(tar, { level: 9 }));
  out.writeUInt32LE(0, 4);
  return out;
}

export function tgzDecompress(tgz: Buffer): Buffer {
  try {
    return Buffer.from(gunzipSync(tgz));
  } catch {
    throw new PackError("ARTIFACT_TAMPERED", "Archive bytes are not a valid gzip stream; the file may have been modified.");
  }
}

function walkPackage(pkgDir: string): TarEntry[] {
  const entries: TarEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relativePath = relative(pkgDir, full).split(sep).join("/");
      if (statSync(full).isDirectory()) {
        entries.push({ path: relativePath, data: Buffer.alloc(0), dir: true });
        walk(full);
      } else {
        entries.push({ path: relativePath, data: readFileSync(full), dir: false });
      }
    }
  };
  walk(pkgDir);
  return entries;
}

export interface PackOptions {
  skill?: string;
  force?: boolean;
  outFile?: string;
}

export interface PackedSkill {
  outFile: string;
  skillId: string;
  version: string;
}

/**
 * Pack one built public level-0 skill into `<id>-<version>.tgz`.
 * Refuses dev/test-kid containers (BUILD_DEV_PACK_REFUSED), any protected
 * entry (BUILD_TIER_PACK_REFUSED), and layout violations
 * (BUILD_LAYOUT_PACK_REFUSED). An existing output needs --force
 * (BUILD_FILE_EXISTS).
 */
export function packSkill(workspaceDir: string, options: PackOptions = {}): PackedSkill {
  const distDir = join(workspaceDir, "dist", "skills");
  let names: string[];
  try {
    names = readdirSync(distDir);
  } catch {
    throw new Error(`No built packages: ${distDir} does not exist. Run 'ssf build' first.`);
  }
  const skill = options.skill ?? (names.length === 1 ? names[0] : undefined);
  if (!skill) {
    throw new Error(names.length === 0 ? "dist/skills/ has no packages. Run 'ssf build' first." : "Multiple packages found; pass a skill name.");
  }
  const pkgDir = join(distDir, skill);
  let container;
  try {
    container = decodeContainer(readFileSync(join(pkgDir, "scripts", "runtime.bin")));
  } catch {
    throw new PackError("ARTIFACT_TAMPERED", `Package ${skill} is damaged or incomplete.`);
  }
  if (isTestKid(container.rootKid)) {
    throw new PackError("BUILD_DEV_PACK_REFUSED", `Package ${skill} is a dev/test build (kid ${container.rootKid}); dev packages must never be published.`);
  }
  const manifestText = readFileSync(join(pkgDir, "skill.manifest"), "utf8");
  const manifest = parseSkillManifestText(manifestText);
  const layout = validateDistribution(pkgDir);
  if (layout.errors.length > 0) {
    throw new PackError("BUILD_LAYOUT_PACK_REFUSED", `Package ${skill} fails distribution layout: ${layout.errors.map((entry) => entry.message).join("; ")}`);
  }
  // The container holds protected companions and scripts only; a public
  // level-0 skill ships an empty one. Anything inside is a higher tier.
  if (container.entries.length > 0) {
    throw new PackError("BUILD_TIER_PACK_REFUSED", `Package ${skill} is not public level-0 (${container.entries.length} protected entries); packs carry public skills only.`);
  }
  const outFile = options.outFile ?? join(workspaceDir, `${manifest.skill.id}-${manifest.skill.version}.tgz`);
  try {
    if (statSync(outFile).isFile() && options.force !== true) {
      throw new PackError("BUILD_FILE_EXISTS", `${outFile} already exists; pass --force to overwrite.`);
    }
  } catch (error) {
    if (error instanceof PackError) {
      throw error;
    }
    // Missing output path: proceed to write.
  }
  const archive = tgzCompress(tarCreate(walkPackage(pkgDir)));
  writeFileSync(outFile, archive);
  return { outFile, skillId: manifest.skill.id, version: manifest.skill.version };
}

export interface UnpackOptions {
  dir?: string;
  force?: boolean;
}

export interface UnpackedSkill {
  dir: string;
  skillId: string;
  version: string;
}

/**
 * Unpack a `.tgz` made by `ssf pack` and verify it: gzip CRC, tar header
 * checksums, safe paths, distribution layout, and container integrity.
 * Any failure is ARTIFACT_TAMPERED; an existing directory needs --force.
 */
export function unpackSkill(archiveFile: string, options: UnpackOptions = {}): UnpackedSkill {
  const entries = tarExtract(tgzDecompress(readFileSync(archiveFile)));
  // Read the manifest from the archive first so the default directory is
  // the skill id (the distribution layout requires folder name = skill id).
  const manifestEntry = entries.find((entry) => entry.path === "skill.manifest" && !entry.dir);
  if (!manifestEntry) {
    throw new PackError("ARTIFACT_TAMPERED", "Archive has no skill.manifest at its root.");
  }
  let manifest;
  try {
    manifest = parseSkillManifestText(manifestEntry.data.toString("utf8"));
  } catch {
    throw new PackError("ARTIFACT_TAMPERED", "Archive skill.manifest does not parse.");
  }
  const dir = options.dir ?? join(dirname(archiveFile), manifest.skill.id);
  try {
    if (statSync(dir).isDirectory() && options.force !== true) {
      const existing = readdirSync(dir);
      if (existing.length > 0) {
        throw new PackError("BUILD_FILE_EXISTS", `${dir} already exists and is not empty; pass --force to overwrite.`);
      }
    }
  } catch (error) {
    if (error instanceof PackError) {
      throw error;
    }
    // Missing directory: proceed to create.
  }
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    const full = join(dir, entry.path);
    if (entry.dir) {
      mkdirSync(full, { recursive: true });
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, entry.data);
    }
  }
  const layout = validateDistribution(dir);
  if (layout.errors.length > 0) {
    throw new PackError("ARTIFACT_TAMPERED", `Unpacked package fails distribution layout: ${layout.errors.map((entry) => entry.message).join("; ")}`);
  }
  try {
    decodeContainer(readFileSync(join(dir, "scripts", "runtime.bin")));
  } catch {
    throw new PackError("ARTIFACT_TAMPERED", "Unpacked container fails its integrity check; the archive may have been modified.");
  }
  return { dir, skillId: manifest.skill.id, version: manifest.skill.version };
}
