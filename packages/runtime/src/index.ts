// @ssf/runtime - skill runtime: license checks, protected access, scripts.
// Sprint 5 implements the fail-closed flow (F-45), the SkillRuntime API
// (F-46), list/read/search/run (F-48-F-51), context caps (F-52), in-memory
// execution (F-53), artifact verification (F-54), state locations (F-55),
// public access (F-56), spread license checks (F-26), and the agent CLI
// (F-47). Output formats follow the agent contract.

// F-58/F-59/F-60 live in @ssf/agent-contract; re-export the contract names
// this package used to own so existing consumers keep working.
export {
  buildNotice,
  confidentialityHeader,
  DEFAULT_NOTICE_BODY,
  DEFAULT_NOTICE_BODY_ID,
  attachNotice,
  formatListText,
  formatReadText,
  formatRunText,
  formatSearchText,
  RuntimeError,
  formatRuntimeError,
  type AttachNoticeOptions,
  type ContractLang,
  type FormatLanguage,
  type HiddenCounts,
  type ListEntry,
  type ReadResult,
  type ReadTextOptions,
  type RunResult,
  type RuntimeErrorCode,
  type SearchResult,
} from "@ssf/agent-contract";
export * from "./state.js";
export * from "./online.js";
export * from "./container.js";
export * from "./paginate.js";
export * from "./exec.js";
export * from "./api.js";
export * from "./cli.js";
export * from "./installed.js";

export const PACKAGE_NAME = "@ssf/runtime";
