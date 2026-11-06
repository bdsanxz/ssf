// Default codec plugin (F-67): tier-1 text encoding for obfuscated files.
// The framework's own tier-1 step runs through the hook runner like any
// other transform (never special-cased in the pipeline): obfuscated text is
// base64-wrapped at build time and unwrapped by the runtime on read.

import { encodeTier1Text } from "@ssf/crypto";
import type { SsfPlugin } from "@ssf/plugin-api";

export const CODEC_DEFAULT_PLUGIN = "codec-default";

export const codecDefaultPlugin: SsfPlugin = {
  name: CODEC_DEFAULT_PLUGIN,
  apiVersion: 1,
  build: {
    transformSource: async (_context, code: string): Promise<string> => code,
    transformCompanion: async (context, content: string): Promise<string> =>
      context.protection === "obfuscated" ? encodeTier1Text(content) : content,
  },
};
