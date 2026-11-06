// F-40: license issuance (admin and CI only).
// The issuer derives per-version content keys from the publisher root
// secret, so no per-version key storage exists. Customers only ever receive
// the package plus the token string. Never commit the root secret or the
// signing key used here.

import { randomBytes, type KeyObject } from "node:crypto";
import { deriveContentKey } from "@ssf/crypto";
import { payloadToBytes, signTokenPayload, type LicensePayload } from "./token.js";

export interface IssueSkill {
  skillId: string;
  version: string;
}

export interface IssueOptions {
  rootSecret: Buffer;
  licensePrivateKey: KeyObject;
  licenseKid: string;
  publisher: string;
  skills: IssueSkill[];
  /** Expiry as unix seconds. */
  expiresAt: number;
  licenseId?: string;
  customer?: string;
  ext?: Record<string, unknown>;
  nowSeconds?: number;
  /**
   * F-35/F-41: online tokens carry no content_keys (the lease delivers the
   * key per use); offline tokens embed one key per skill@version.
   */
  mode?: "offline" | "online";
}

export interface IssuedLicense {
  token: string;
  payload: LicensePayload;
  licenseId: string;
}

/** Mint a multi-skill offline token and return it with its payload. */
export function issueLicense(options: IssueOptions): IssuedLicense {
  if (options.rootSecret.length !== 32) {
    throw new Error("Issuing needs a 32-byte publisher root secret.");
  }
  if (options.skills.length === 0) {
    throw new Error("Issuing needs at least one skill.");
  }
  const licenseId = options.licenseId ?? `lic_${randomBytes(8).toString("hex")}`;
  const mode = options.mode ?? "offline";
  const contentKeys: Record<string, string> = {};
  if (mode === "offline") {
    for (const skill of options.skills) {
      const contentKey = deriveContentKey(options.rootSecret, skill.skillId, skill.version);
      contentKeys[`${skill.skillId}@${skill.version}`] = contentKey.toString("base64url");
    }
  }
  const payload: LicensePayload = {
    license_id: licenseId,
    publisher: options.publisher,
    mode,
    skills: options.skills.map((skill) => skill.skillId),
    issued_at: options.nowSeconds ?? Math.floor(Date.now() / 1000),
    expires_at: options.expiresAt,
    content_keys: contentKeys,
    ext: options.ext ?? {},
  };
  const token = signTokenPayload(options.licensePrivateKey, payloadToBytes(payload), options.licenseKid);
  return { token, payload, licenseId };
}
