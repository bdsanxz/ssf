// F-92: per-license watermark for protected companion text.
// The plugin appends a fingerprint line identifying the issuing license to
// every protected companion read, so leaked content traces back to the
// license in the issuance log. The fingerprint is an HMAC, so holders can
// see (but not forge) the mark; removal is possible by anyone holding the
// plaintext, so watermarks are tracing and deterrent, not access control.

import { createHmac } from "node:crypto";
import type { SsfPlugin } from "@ssf/plugin-api";

export const WATERMARK_PLUGIN = "watermark";

/** Marker trailer: [ssf-watermark <license_id>:<fingerprint>]. */
const MARKER_PATTERN = /\[ssf-watermark ([A-Za-z0-9_-]+):([0-9a-f]{12})\]/;

export interface WatermarkOptions {
  /** Publisher HMAC secret (never shipped; at least 16 chars). */
  secret: string;
}

/** Derive the 12-hex fingerprint binding one license id to the secret. */
export function watermarkFingerprint(secret: string, licenseId: string): string {
  return createHmac("sha256", secret).update(licenseId, "utf8").digest("hex").slice(0, 12);
}

/** Render the marker trailer for one license id. */
export function watermarkMarker(secret: string, licenseId: string): string {
  return `[ssf-watermark ${licenseId}:${watermarkFingerprint(secret, licenseId)}]`;
}

/** Extract a marker from leaked text (parse only; use verifyWatermark to authenticate). */
export function extractWatermark(text: string): { licenseId: string; fingerprint: string } | null {
  const found = MARKER_PATTERN.exec(text);
  if (!found) {
    return null;
  }
  return { licenseId: found[1] as string, fingerprint: found[2] as string };
}

/** True when the text carries a marker for this license id made with this secret. */
export function verifyWatermark(text: string, secret: string, licenseId: string): boolean {
  const extracted = extractWatermark(text);
  if (extracted === null || extracted.licenseId !== licenseId) {
    return false;
  }
  return extracted.fingerprint === watermarkFingerprint(secret, licenseId);
}

/**
 * Watermark plugin: appends the license marker to protected companion text
 * after read. Stateless per call: the license id comes from the afterRead
 * context, so concurrent runtimes with different licenses never mix marks.
 */
export function createWatermarkPlugin(options: WatermarkOptions): SsfPlugin {
  if (typeof options.secret !== "string" || options.secret.length < 16) {
    throw new Error("Watermark needs a secret of at least 16 characters.");
  }
  const secret = options.secret;
  return {
    name: WATERMARK_PLUGIN,
    apiVersion: 1,
    capabilities: [],
    runtime: {
      afterRead: async (context, text): Promise<string> => {
        const marker = watermarkMarker(secret, context.license.license_id);
        return text.endsWith("\n") ? `${text}${marker}\n` : `${text}\n${marker}\n`;
      },
    },
  };
}
