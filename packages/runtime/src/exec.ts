// F-53: in-memory script execution.
// Scripts run from memory: decrypted code is piped to a child Node process
// over stdin, never written to disk as plaintext, with no source maps. The
// timeout kills the child (SCRIPT_TIMEOUT); stdout and stderr are capped
// with a follow-up hint. Errors report the kind and message with the stack
// minimized, never script source. Scripts run with full user rights: this is
// not a sandbox, and trust rests on the artifact signature.

import { spawn } from "node:child_process";

export interface MemoryExecOptions {
  args: string[];
  timeoutMs: number;
  maxChars: number;
  cwd?: string;
  killSignal?: NodeJS.Signals;
}

export interface MemoryExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/** Node flags that must never reach a script through run arguments. */
const DENIED_ARG_PATTERNS = [/^--inspect/, /^--debug/, /^--trace/, /^--expose/, /^(-r|--require)$/, /^--import$/, /^--experimental/, /^--loader/, /^--v8-/];

/**
 * Drop Node debug and loader flags from run arguments. A bare -- is CLI
 * syntax, not a script arg. Flags that take a module value (-r/--require,
 * --import, --loader, --experimental-loader) drop their value too.
 */
const VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader"]);

export function sanitizeRunArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--") {
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (DENIED_ARG_PATTERNS.some((pattern) => pattern.test(arg))) {
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** Shrink an error trace to its kind and message lines. */
export function sanitizeScriptError(output: string): string {
  const kept: string[] = [];
  for (const line of output.split("\n")) {
    if (/^\s+at\s/.test(line)) {
      continue;
    }
    kept.push(line);
    if (kept.length >= 8) {
      break;
    }
  }
  return kept.join("\n").trim();
}

/** Execute JavaScript source from memory in a child Node process. */
export function runFromMemory(code: string, options: MemoryExecOptions): Promise<MemoryExecResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-", ...options.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const byteCap = options.maxChars * 4;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, Math.max(1, options.timeoutMs));
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < byteCap) {
        stdout.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < byteCap) {
        stderr.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: "Failed to start the script process.", timedOut, truncated: false });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const outPoints = Array.from(decoder.decode(Buffer.concat(stdout)));
      const errPoints = Array.from(decoder.decode(Buffer.concat(stderr)));
      const cutStdout = outPoints.length > options.maxChars;
      const cutStderr = errPoints.length > options.maxChars;
      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout: (cutStdout ? outPoints.slice(0, options.maxChars) : outPoints).join(""),
        stderr: (cutStderr ? errPoints.slice(0, options.maxChars) : errPoints).join(""),
        timedOut,
        truncated: cutStdout || cutStderr,
      });
    });

    try {
      child.stdin.write(code, "utf8");
      child.stdin.end();
    } catch {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", stderr: "Failed to feed the script process.", timedOut, truncated: false });
    }
  });
}
