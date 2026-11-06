// F-52: context management for read/search/run output.
// Reads cap at 500 lines per call plus a character cap, paginated with
// start/limit and next_start. Character cuts never split surrogate pairs or
// combining marks: truncation counts Unicode code points. Line endings are
// normalized (\\r?\\n). These caps manage context windows; they do not stop
// extraction by a determined holder.

export const MAX_LINES_PER_READ = 500;
export const DEFAULT_MAX_CHARS = 40000;
export const DEFAULT_SEARCH_RESULTS = 20;
export const DEFAULT_SNIPPET_CHARS = 120;

/** Split text into lines after normalizing CRLF. A single trailing newline does not add a line. */
export function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** Cut a string to a code-point budget without splitting characters. */
export function truncateChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  const points = Array.from(text);
  if (points.length <= maxChars) {
    return { text, truncated: false };
  }
  return { text: points.slice(0, maxChars).join(""), truncated: true };
}

export interface Page {
  content: string;
  start: number;
  end: number;
  totalLines: number;
  truncated: boolean;
  nextStart: number | null;
}

/** Paginate lines with a 1-based start and a line cap. */
export function paginateLines(lines: string[], start: number, limit: number): Page {
  const clampedStart = Math.max(1, Math.floor(start));
  const clampedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_LINES_PER_READ));
  const slice = lines.slice(clampedStart - 1, clampedStart - 1 + clampedLimit);
  const end = slice.length === 0 ? clampedStart - 1 : clampedStart + slice.length - 1;
  const truncated = clampedStart - 1 + clampedLimit < lines.length;
  return {
    content: slice.join("\n"),
    start: clampedStart,
    end,
    totalLines: lines.length,
    truncated,
    nextStart: truncated ? end + 1 : null,
  };
}
