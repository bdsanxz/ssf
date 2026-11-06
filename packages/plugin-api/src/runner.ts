// Plugin hook runner (F-62/F-66): composition modes, timeouts, fail-closed
// wrapping. Modes:
// - first: first non-null result wins (key providers).
// - waterfall: each hook transforms the previous output (text transforms).
// - sequential: every hook runs for effects (lifecycle); pre/post pairs are
//   invoked by the caller in order, so no plugin can skip another.
// - all: every hook must allow; one denial, throw, timeout, or invalid
//   return fails the operation (license verifiers).
// Any throw, timeout, or wrong-typed return becomes a PLUGIN_ERROR with the
// plugin name; secret-looking values in plugin errors are redacted.

import { isRuntimeErrorCode, RuntimeError } from "@ssf/agent-contract";
import { DeniedByPlugin, type PluginContext, type SsfPlugin } from "./plugin.js";

/** Hook label used in error messages, e.g. "runtime.verifyLicense". */
export type HookName = string;

export interface RunnerOptions {
  timeoutMs?: number;
}

export const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

const SECRET_PATTERN = /(ssf1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|BEGIN [A-Z ]*PRIVATE KEY|sk-[A-Za-z0-9]{8,}|xox[bpas]-[A-Za-z0-9-]+)/g;

/** Redact secret-looking values from text a plugin produced (error paths). */
export function redactPluginText(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

function pluginError(plugin: SsfPlugin, hook: HookName, reason: string): RuntimeError {
  return new RuntimeError("PLUGIN_ERROR", `plugin "${plugin.name}" hook "${hook}" failed: ${redactPluginText(reason)}`);
}

function withTimeout<T>(plugin: SsfPlugin, hook: HookName, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(pluginError(plugin, hook, `timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function callHook<T>(
  plugin: SsfPlugin,
  hook: HookName,
  invoke: () => Promise<T>,
  validate: (value: T) => boolean,
  options: RunnerOptions,
): Promise<T> {
  let value: T;
  try {
    value = await withTimeout(plugin, hook, invoke(), options.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof DeniedByPlugin) {
      throw error;
    }
    if (error instanceof RuntimeError && error.code === "PLUGIN_ERROR") {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw pluginError(plugin, hook, reason);
  }
  if (!validate(value)) {
    throw pluginError(plugin, hook, `returned an invalid value`);
  }
  return value;
}

/**
 * First non-null result wins; null means "no result". Callers pass only the
 * plugins that register this hook, already ordered (pre, default, post) and
 * filtered to the current dev/prod mode.
 */
export async function runFirstWins<TContext extends PluginContext, TResult>(
  plugins: SsfPlugin[],
  hook: HookName,
  context: TContext,
  invoke: (plugin: SsfPlugin, context: TContext) => Promise<TResult | null>,
  options: RunnerOptions = {},
): Promise<{ plugin: string; value: TResult } | null> {
  for (const plugin of plugins) {
    const value = await callHook(plugin, hook, () => invoke(plugin, context), (result) => result === null || result !== undefined, options);
    if (value !== null && value !== undefined) {
      return { plugin: plugin.name, value: value as TResult };
    }
  }
  return null;
}

/** Each hook transforms the previous output; the last output wins. */
export async function runWaterfall<TContext extends PluginContext>(
  plugins: SsfPlugin[],
  hook: HookName,
  context: TContext,
  initial: string,
  invoke: (plugin: SsfPlugin, context: TContext, text: string) => Promise<string>,
  options: RunnerOptions = {},
): Promise<string> {
  let current = initial;
  for (const plugin of plugins) {
    current = await callHook(plugin, hook, () => invoke(plugin, context, current), (result) => typeof result === "string", options);
  }
  return current;
}

/**
 * Each hook receives the previous draft and resolves the next one. Used for
 * structured chainables like issueLicense, where the value is an object and
 * each step is validated before it becomes the next input.
 */
export async function runChainable<TContext extends PluginContext, TDraft extends object>(
  plugins: SsfPlugin[],
  hook: HookName,
  context: TContext,
  initial: TDraft,
  invoke: (plugin: SsfPlugin, context: TContext, draft: TDraft) => Promise<TDraft>,
  isValid: (draft: TDraft) => boolean,
  options: RunnerOptions = {},
): Promise<TDraft> {
  let current = initial;
  for (const plugin of plugins) {
    current = await callHook(plugin, hook, () => invoke(plugin, context, current), isValid, options);
  }
  return current;
}

/** Every registered hook runs in order; any failure aborts (fail-closed). */
export async function runSequential<TContext extends PluginContext>(
  plugins: SsfPlugin[],
  hook: HookName,
  context: TContext,
  invoke: (plugin: SsfPlugin, context: TContext) => Promise<void>,
  options: RunnerOptions = {},
): Promise<void> {
  for (const plugin of plugins) {
    await callHook(plugin, hook, () => invoke(plugin, context), (result) => result === undefined, options);
  }
}

/**
 * Every verifier must allow. A denial becomes PLUGIN_DENIED naming the
 * plugin; a throw, timeout, or invalid return becomes PLUGIN_ERROR.
 */
export async function runAllAllow<TContext extends PluginContext>(
  plugins: SsfPlugin[],
  hook: HookName,
  context: TContext,
  invoke: (plugin: SsfPlugin, context: TContext) => Promise<boolean | void>,
  options: RunnerOptions = {},
): Promise<void> {
  for (const plugin of plugins) {
    let allowed: boolean | void;
    try {
      allowed = await callHook(
        plugin,
        hook,
        () => invoke(plugin, context),
        (result) => typeof result === "boolean" || result === undefined,
        options,
      );
    } catch (error) {
      if (error instanceof DeniedByPlugin) {
        const code = isRuntimeErrorCode(error.code) ? error.code : "PLUGIN_DENIED";
        throw new RuntimeError(code, error.message);
      }
      throw error;
    }
    if (allowed === false) {
      throw new RuntimeError("PLUGIN_DENIED", `plugin "${plugin.name}" denied this operation.`);
    }
  }
}
