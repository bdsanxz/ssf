// @ssf/build - deterministic, diversified release pipeline.
// Sprint 4 implements the pipeline stages: validation, quality gates,
// bundling, minification, obfuscation, protection, container packing,
// signing, layout, release log, and the final leak scan.

export * from "./diversify.js";
export * from "./bundle.js";
export * from "./minify.js";
export * from "./publicManifest.js";
export * from "./layout.js";
export * from "./releases.js";
export * from "./leakscan.js";
export * from "./runtimeTemplate.js";
export * from "./pipeline.js";

export const PACKAGE_NAME = "@ssf/build";
