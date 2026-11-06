// @ssf/cli - unified ssf command line interface and defineConfig helper.
// new/generate (F-69/F-70), validate (F-74), build/dev (F-75/F-76), keys
// (F-78), and license commands (F-79) live in their own modules.

export * from "./config.js";
export * from "./workspace.js";
export * from "./license.js";
export * from "./keys.js";
export * from "./plugins.js";
export * from "./scaffold.js";
export * from "./validate.js";
export * from "./buildCmd.js";

export const PACKAGE_NAME = "@ssf/cli";
