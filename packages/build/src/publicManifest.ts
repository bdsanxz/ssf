// F-29: public manifest generator.
// The skill.manifest shipped in a package carries only metadata and the
// public file list. Protected companion entries and every script move into
// the index inside runtime.bin, so their paths, descriptions, and usage
// never appear outside the encrypted container.

import type { SkillManifest } from "@ssf/manifest";

/** Build the public-only manifest for one skill package. */
export function buildPublicManifest(manifest: SkillManifest): SkillManifest {
  return {
    skill: manifest.skill,
    ...(manifest.license ? { license: manifest.license } : {}),
    ...(manifest.limits ? { limits: manifest.limits } : {}),
    companion_files: (manifest.companion_files ?? []).filter(
      (file) => (file.protection ?? "none") === "none",
    ),
  };
}
