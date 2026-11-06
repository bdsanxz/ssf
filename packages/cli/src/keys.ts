// F-78: publisher key management in keys/ (gitignored).
// Layout per kid: <kid>.root.hex (32 bytes hex), <kid>.license.pem (private)
// + <kid>.license.pub.pem, <kid>.artifact.pem + <kid>.artifact.pub.pem,
// <kid>.lease.pem (private, online service only) + <kid>.lease.pub.pem.
// Private files are written 0600. Existing files are never overwritten.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateRootSecret, generateSigningKeypair } from "@ssf/crypto";

export interface KeyGenFlags {
  dir: string;
  kid?: string;
  dev?: boolean;
  force?: boolean;
}

function pemPaths(dir: string, kid: string) {
  return {
    rootHex: join(dir, `${kid}.root.hex`),
    licensePem: join(dir, `${kid}.license.pem`),
    licensePub: join(dir, `${kid}.license.pub.pem`),
    artifactPem: join(dir, `${kid}.artifact.pem`),
    artifactPub: join(dir, `${kid}.artifact.pub.pem`),
    leasePem: join(dir, `${kid}.lease.pem`),
    leasePub: join(dir, `${kid}.lease.pub.pem`),
  };
}

function exists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Generate a keypair and root secret for one kid. */
export function generateKeys(flags: KeyGenFlags): { text: string; kid: string } {
  const kid = flags.dev === true ? "dev" : (flags.kid ?? "").trim();
  if (!kid) {
    throw new Error("ssf keys generate needs --kid <kid> or --dev. Test kids (dev, example) are rejected in production builds.");
  }
  mkdirSync(flags.dir, { recursive: true });
  const paths = pemPaths(flags.dir, kid);
  const clash = Object.values(paths).filter(exists);
  if (clash.length > 0 && flags.force !== true) {
    throw new Error(`Keys for kid "${kid}" already exist (${clash.length} file(s)). Delete them first or use --force.`);
  }
  const rootSecret = generateRootSecret();
  const license = generateSigningKeypair();
  const artifact = generateSigningKeypair();
  const lease = generateSigningKeypair();
  writeFileSync(paths.rootHex, `${rootSecret.toString("hex")}\n`, { mode: 0o600 });
  writeFileSync(paths.licensePem, license.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  writeFileSync(paths.licensePub, license.publicKey.export({ format: "pem", type: "spki" }).toString());
  writeFileSync(paths.artifactPem, artifact.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  writeFileSync(paths.artifactPub, artifact.publicKey.export({ format: "pem", type: "spki" }).toString());
  writeFileSync(paths.leasePem, lease.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  writeFileSync(paths.leasePub, lease.publicKey.export({ format: "pem", type: "spki" }).toString());
  const lines = [
    `kid: ${kid}`,
    `  root secret: ${paths.rootHex}`,
    `  license key: ${paths.licensePem} (${paths.licensePub})`,
    `  artifact key: ${paths.artifactPem} (${paths.artifactPub})`,
    `  lease key: ${paths.leasePem} (${paths.leasePub})`,
  ];
  if (kid === "dev" || kid === "example") {
    lines.push("WARNING: test kids are rejected in production builds; dev packages must never be published.");
  }
  return { text: lines.join("\n"), kid };
}

export interface PublisherKeyMaterial {
  rootSecret: Buffer;
  licensePrivateKeyPem: string;
  licensePublicKeyPem: string;
  artifactPrivateKeyPem: string;
  /** Lease key PEMs; present only when a lease kid is requested. */
  leasePrivateKeyPem?: string;
  leasePublicKeyPem?: string;
}

export interface PublisherKids {
  rootKid: string;
  licenseKid: string;
  artifactKid: string;
  /** Lease signing kid; enables online leases in builds when set. */
  leaseKid?: string;
}

function readText(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new Error(`Missing ${what}: ${path}. Run 'ssf keys generate --kid <kid>' first.`);
  }
}

/**
 * Backfill the lease pair for a kid that predates lease provisioning
 * (F-42). Creates the pair only when absent; existing files are never
 * touched, so no other key material rotates.
 */
export function ensureLeaseKeys(dir: string, kid: string): { text: string; created: boolean } {
  if (!kid) {
    throw new Error("ssf keys lease needs --kid <kid> or --dev.");
  }
  const paths = pemPaths(dir, kid);
  const pemExists = exists(paths.leasePem);
  const pubExists = exists(paths.leasePub);
  if (pemExists && pubExists) {
    return { text: `lease key: ${paths.leasePem} (${paths.leasePub}) already exists.`, created: false };
  }
  if (pemExists !== pubExists) {
    throw new Error(`Lease key for kid "${kid}" is half-written. Delete the leftover file first.`);
  }
  mkdirSync(dir, { recursive: true });
  const lease = generateSigningKeypair();
  writeFileSync(paths.leasePem, lease.privateKey.export({ format: "pem", type: "pkcs8" }).toString(), { mode: 0o600 });
  writeFileSync(paths.leasePub, lease.publicKey.export({ format: "pem", type: "spki" }).toString());
  return { text: `lease key: ${paths.leasePem} (${paths.leasePub})`, created: true };
}

/** Load publisher key material for build and license commands. */
export function loadPublisherKeys(dir: string, kids: PublisherKids): PublisherKeyMaterial {
  const rootHex = readText(join(dir, `${kids.rootKid}.root.hex`), "root secret").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(rootHex)) {
    throw new Error(`Root secret for kid "${kids.rootKid}" must be 64 hex chars (32 bytes).`);
  }
  const material: PublisherKeyMaterial = {
    rootSecret: Buffer.from(rootHex, "hex"),
    licensePrivateKeyPem: readText(join(dir, `${kids.licenseKid}.license.pem`), "license private key"),
    licensePublicKeyPem: readText(join(dir, `${kids.licenseKid}.license.pub.pem`), "license public key"),
    artifactPrivateKeyPem: readText(join(dir, `${kids.artifactKid}.artifact.pem`), "artifact private key"),
  };
  if (kids.leaseKid !== undefined) {
    try {
      material.leasePrivateKeyPem = readFileSync(join(dir, `${kids.leaseKid}.lease.pem`), "utf8");
      material.leasePublicKeyPem = readFileSync(join(dir, `${kids.leaseKid}.lease.pub.pem`), "utf8");
    } catch {
      throw new Error(`Missing lease key for kid "${kids.leaseKid}". Run 'ssf keys lease --kid ${kids.leaseKid}' first.`);
    }
  }
  return material;
}
