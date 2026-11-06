// F-55: runtime locations and user state (plus F-38 last_seen wiring).
// The skill folder is never written to: installs may be symlinks or shared
// caches replaced on update. Leases, last_seen, and caches live in the user
// config dir keyed by publisher/skill-id. The container path resolves
// relative to the runtime file itself, never the working directory.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** User config dir: XDG_CONFIG_HOME or ~/.config. */
export function userConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg && xdg.length > 0) {
    return xdg;
  }
  return join(homedir(), ".config");
}

/** State dir for one publisher skill. Created on first use. */
export function skillStateDir(configDir: string, publisher: string, skillId: string): string {
  const dir = join(configDir, publisher, skillId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a file readable only by the owner (0600). */
export function writePrivateFile(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
}

/** Lease file path for one skill (online mode stores the signed lease here). */
export function leasePath(stateDir: string): string {
  return join(stateDir, "lease");
}

/** last_seen file path for one skill (F-38 clock rollback detection). */
export function lastSeenPath(stateDir: string): string {
  return join(stateDir, "last_seen");
}

/** Resolve scripts/runtime.bin next to the runtime file itself. */
export function containerPathForRuntimeFile(runtimeFile: string): string {
  return join(dirname(runtimeFile), "runtime.bin");
}
