// F-54: artifact verification in the runtime.
// The container is loaded, integrity-checked, and signature-verified BEFORE
// any decryption. A damaged or modified artifact fails with ARTIFACT_INVALID
// and decryption never starts.

import { readFileSync } from "node:fs";
import type { KeyObject } from "node:crypto";
import { assertArtifactSignature, decodeContainer, type ContainerEntry } from "@ssf/crypto";
import { RuntimeError } from "@ssf/agent-contract";
import { containerPathForRuntimeFile } from "./state.js";

export interface LoadedContainer {
  bytes: Buffer;
  rootKid: string;
  entries: ContainerEntry[];
}

/** Load and integrity-check a container file. */
export function loadContainer(containerPath: string): LoadedContainer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(containerPath);
  } catch {
    throw new RuntimeError("ARTIFACT_INVALID", "Skill package is damaged or modified; the container is unreadable.");
  }
  try {
    const decoded = decodeContainer(bytes);
    return { bytes, rootKid: decoded.rootKid, entries: decoded.entries };
  } catch {
    throw new RuntimeError("ARTIFACT_INVALID", "Skill package is damaged or modified; the container failed its integrity check.");
  }
}

/** Load the container sitting next to a runtime file. */
export function loadContainerForRuntimeFile(runtimeFile: string): LoadedContainer {
  return loadContainer(containerPathForRuntimeFile(runtimeFile));
}

/** Verify the artifact signature before any decryption happens. */
export function verifyArtifactBeforeDecrypt(
  artifactPublicKey: KeyObject,
  container: LoadedContainer,
  signature: Buffer,
): void {
  try {
    assertArtifactSignature(artifactPublicKey, container.bytes, signature);
  } catch {
    throw new RuntimeError("ARTIFACT_INVALID", "Skill package signature is invalid; the artifact may have been modified.");
  }
}
