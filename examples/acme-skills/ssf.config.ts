// Example publisher workspace config (F-05).
// Uses kid "example" so production runtimes reject tokens and artifacts from it.
// WARNING: ssf.config.ts is executed code (like vite.config.ts).
// Do not run ssf in an untrusted workspace.

import { defineConfig } from "@ssf/cli";

export default defineConfig({
  workspace: { publisher: "acme", defaultMode: "offline" },

  license: {
    env: "ACME_SSF_LICENSE",
    configFile: "acme/license",
  },

  keys: {
    dir: "./keys",
    licenseKid: "example",
    artifactKid: "example",
    rootKid: "example",
  },

  limits: {
    defaultMaxLines: 500,
    defaultMaxChars: 40000,
    defaultScriptOutputChars: 20000,
    defaultScriptTimeoutSeconds: 120,
  },

  agent: {
    confidentialityNotice: { enabled: true },
    allowedTools: undefined,
  },

  build: {
    obfuscate: { scripts: true, runtime: true },
    diversify: true,
  },

  skills: ["skills/pdf-helper", "skills/report-writer"],

  plugins: [],
});
