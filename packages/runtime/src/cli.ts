// F-47: agent-facing runtime CLI (node scripts/runtime.js ...).
// Commands run relative to the skill folder; --json serves programmatic
// callers while the default text targets LLM readers. Errors print in the
// ERROR <CODE> contract with the matching exit code.

import {
  buildNotice,
  formatListText,
  formatReadText,
  formatRunText,
  formatSearchText,
  RuntimeError,
  formatRuntimeError,
} from "@ssf/agent-contract";
import type { SkillRuntime } from "./api.js";

/** Format an error without a runtime instance (for argument parsing). */
export function formatRuntimeErrorFor(error: unknown): { text: string; exitCode: number } {
  if (error instanceof RuntimeError) {
    return { text: formatRuntimeError(error), exitCode: error.exitCode };
  }
  return { text: "ERROR INTERNAL\nUnexpected runtime failure.", exitCode: 1 };
}

export type Command =
  | { name: "list"; path?: string; scripts: boolean; json: boolean; debug: boolean }
  | { name: "read"; path: string; start?: number; limit?: number; maxChars?: number; json: boolean; debug: boolean }
  | { name: "search"; path: string; query: string; maxResults?: number; json: boolean; debug: boolean }
  | { name: "run"; id: string; args: string[]; json: boolean; debug: boolean }
  | { name: "extract"; path: string; out: string; json: boolean; debug: boolean };

export const USAGE =
  "Usage:\n" +
  "  node scripts/runtime.js list [path] [--scripts] [--json]\n" +
  "  node scripts/runtime.js read <path> [--start N] [--limit N] [--max-chars N] [--json]\n" +
  "  node scripts/runtime.js search <path> \"<query>\" [--max-results N] [--json]\n" +
  "  node scripts/runtime.js run <id> [-- <args...>] [--json]\n" +
  "  node scripts/runtime.js extract <path> --out <file> [--json]";

function isFlag(value: string, name: string): boolean {
  return value === `--${name}`;
}

function takeNumber(args: string[], name: string): number | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  const raw = args[index + 1];
  const value = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new RuntimeError("PATH_NOT_FOUND", `Option --${name} needs a number.\n${USAGE}`);
  }
  return value;
}

function takeToken(args: string[]): string | undefined {
  const index = args.indexOf("--token");
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function takeString(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function stripOptions(args: string[], names: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (name === "json" || name === "debug" || name === "scripts") {
        i += 1;
        continue;
      }
      if (names.includes(name)) {
        i += 2;
        continue;
      }
      if (name === "token") {
        i += 2;
        continue;
      }
      throw new RuntimeError("PATH_NOT_FOUND", `Unknown option --${name}.\n${USAGE}`);
    }
    out.push(arg);
    i += 1;
  }
  return out;
}

/** Parse CLI args into a command. Throws RuntimeError with usage on misuse. */
export function parseArgv(argv: string[]): { command: Command; token?: string } {
  const token = takeToken(argv);
  const debug = argv.some((arg) => isFlag(arg, "debug"));
  const json = argv.some((arg) => isFlag(arg, "json"));
  const cleaned: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--token") {
      i += 1;
      continue;
    }
    if (arg === "--debug" || arg === "--json") {
      continue;
    }
    cleaned.push(arg);
  }
  const [name, ...rest] = cleaned;
  if (name === "list") {
    const positional = stripOptions(rest, []);
    if (positional.length > 1) {
      throw new RuntimeError("PATH_NOT_FOUND", `Too many arguments for list.\n${USAGE}`);
    }
    return { command: { name: "list", path: positional[0], scripts: rest.some((arg) => isFlag(arg, "scripts")), json, debug }, token };
  }
  if (name === "read") {
    const start = takeNumber(rest, "start");
    const limit = takeNumber(rest, "limit");
    const maxChars = takeNumber(rest, "max-chars");
    const positional = stripOptions(rest, ["start", "limit", "max-chars"]);
    if (positional.length !== 1 || !positional[0]) {
      throw new RuntimeError("PATH_NOT_FOUND", `read needs exactly one path.\n${USAGE}`);
    }
    return { command: { name: "read", path: positional[0], start, limit, maxChars, json, debug }, token };
  }
  if (name === "search") {
    const maxResults = takeNumber(rest, "max-results");
    const positional = stripOptions(rest, ["max-results"]);
    if (positional.length !== 2 || !positional[0] || positional[1] === undefined) {
      throw new RuntimeError("PATH_NOT_FOUND", `search needs a path and a query.\n${USAGE}`);
    }
    return { command: { name: "search", path: positional[0], query: positional[1] as string, maxResults, json, debug }, token };
  }
  if (name === "run") {
    const positional = stripOptions(rest, []);
    if (positional.length < 1 || !positional[0]) {
      throw new RuntimeError("PATH_NOT_FOUND", `run needs a script id.\n${USAGE}`);
    }
    const [id, ...args] = positional as [string, ...string[]];
    return { command: { name: "run", id, args, json, debug }, token };
  }
  if (name === "extract") {
    const out = takeString(rest, "out");
    const positional = stripOptions(rest, ["out"]);
    if (positional.length !== 1 || !positional[0] || !out) {
      throw new RuntimeError("PATH_NOT_FOUND", `extract needs a path and --out <file>.\n${USAGE}`);
    }
    return { command: { name: "extract", path: positional[0], out, json, debug }, token };
  }
  throw new RuntimeError("PATH_NOT_FOUND", `Unknown command.\n${USAGE}`);
}

export interface CommandContext {
  skillId: string;
  publisher: string;
  noticeText?: string;
  noticeEnabled?: boolean;
}

/** Execute a parsed command and render text plus the process exit code. */
export async function executeCommand(
  runtime: SkillRuntime,
  command: Command,
  context: CommandContext,
): Promise<{ text: string; exitCode: number; debugStack?: string }> {
  try {
    if (command.name === "list") {
      const access = await runtime.checkAccess().catch((error: unknown) => {
        if (error instanceof RuntimeError && error.code === "LICENSE_MISSING") {
          return { licensed: false };
        }
        throw error;
      });
      const entries = await runtime.list(command.path, { scripts: command.scripts });
      if (command.json) {
        return { text: JSON.stringify(entries, null, 2), exitCode: 0 };
      }
      return { text: formatListText(context.skillId, entries, { licensed: access.licensed }), exitCode: 0 };
    }
    if (command.name === "read") {
      const result = await runtime.read(command.path, { start: command.start, limit: command.limit, maxChars: command.maxChars });
      if (command.json) {
        return { text: JSON.stringify(result, null, 2), exitCode: 0 };
      }
      const notice = result.isProtected && context.noticeEnabled !== false ? buildNotice(context.publisher, context.noticeText) : undefined;
      return { text: formatReadText(context.skillId, command.path, result, { notice }), exitCode: 0 };
    }
    if (command.name === "search") {
      const results = await runtime.search(command.path, command.query, { maxResults: command.maxResults });
      if (command.json) {
        return { text: JSON.stringify(results, null, 2), exitCode: 0 };
      }
      const notice = results.some((result) => result.isProtected) && context.noticeEnabled !== false ? buildNotice(context.publisher, context.noticeText) : undefined;
      return { text: formatSearchText(context.skillId, command.path, command.query, results, { notice }), exitCode: 0 };
    }
    if (command.name === "extract") {
      const result = await runtime.extract(command.path, { outFile: command.out });
      if (command.json) {
        return { text: JSON.stringify(result, null, 2), exitCode: 0 };
      }
      return { text: `wrote ${result.bytes} bytes to ${result.outFile}`, exitCode: 0 };
    }
    const result = await runtime.run(command.id, command.args);
    if (command.json) {
      return { text: JSON.stringify(result, null, 2), exitCode: result.exitCode };
    }
    return { text: formatRunText(context.skillId, command.id, result), exitCode: result.exitCode };
  } catch (error) {
    const formatted = runtime.formatError(error);
    if (error instanceof RuntimeError && command.debug && error.stack) {
      return { text: formatted.text, exitCode: formatted.exitCode, debugStack: error.stack };
    }
    return { text: formatted.text, exitCode: formatted.exitCode };
  }
}
