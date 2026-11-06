// Agent-facing result shapes for list/read/search/run (F-58).
// These types are the agent consumption contract: every runtime, harness
// adapter, and plugin formatter works against these shapes.

/** One row of a list result: either a companion file or a script id. */
export interface ListEntry {
  id: string;
  kind: "file" | "script";
  visibility: "public" | "protected";
  lines?: number;
  description?: string;
  usage?: string;
}

/** One page of a read result with pagination hints. */
export interface ReadResult {
  content: string;
  start: number;
  end: number;
  totalLines: number;
  truncated: boolean;
  nextStart: number | null;
  /** True when the file is protected (caller attaches the notice). */
  isProtected: boolean;
}

/** One search hit inside a companion file. */
export interface SearchResult {
  /** File the hit came from. */
  path: string;
  line: number;
  snippet: string;
  /** True when the file is protected (caller attaches the notice). */
  isProtected: boolean;
}

/** The outcome of running a script by id. */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  chars: number;
  truncated: boolean;
}
