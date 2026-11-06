// F-38: clock rollback detection via last_seen (best effort).
// The runtime stores the newest observed timestamp in the user config dir.
// A local clock reading older than last_seen means the clock moved back,
// which would wrongly extend cooperative expiry. Detection is best effort:
// it cannot stop a holder who edits the state file or bypasses the runtime.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LAST_SEEN_FILENAME = "last_seen";

/** Read the stored newest-seen unix time, or null when never recorded. */
export function readLastSeen(stateDir: string): number | null {
  try {
    const raw = readFileSync(join(stateDir, LAST_SEEN_FILENAME), "utf8").trim();
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Persist the newest-seen unix time. */
export function writeLastSeen(stateDir: string, nowSeconds: number): void {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, LAST_SEEN_FILENAME), `${nowSeconds}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * True when the clock moved backwards past the stored mark (beyond a small
 * tolerance for skew). Callers should warn, not hard-fail: the check is
 * advisory and the state file is user-writable.
 */
export function detectClockRollback(lastSeen: number | null, nowSeconds: number): boolean {
  if (lastSeen === null) {
    return false;
  }
  return nowSeconds < lastSeen - 60;
}
