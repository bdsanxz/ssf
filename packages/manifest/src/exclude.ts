// F-11: include and exclude matching.
// Manifest exclude patterns keep generated files, editor backups, and test
// sources out of packages (for example "**/*.test.ts" or "**/.DS_Store").
// Supported syntax: "**" crosses directories, "*" stays inside one path
// segment, and "?" matches one character except "/". A pattern without a
// slash matches the file name at any depth.

/** Translate one exclude glob into a RegExp over /-separated logical paths. */
export function globToRegExp(pattern: string): RegExp {
  let body = "";
  const hasSlash = pattern.includes("/");
  const source = hasSlash ? pattern : `**/${pattern}`;
  let i = 0;
  while (i < source.length) {
    const char = source[i] ?? "";
    if (char === "*") {
      if ((source[i + 1] ?? "") === "*") {
        // "**" crosses directories; "**/" also matches zero directories.
        if ((source[i + 2] ?? "") === "/") {
          body += "(?:.*/)?";
          i += 3;
        } else {
          body += ".*";
          i += 2;
        }
      } else {
        body += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      body += "[^/]";
      i += 1;
    } else {
      body += escapeRegExpChar(char);
      i += 1;
    }
  }
  return new RegExp(`^(?:${body})$`);
}

function escapeRegExpChar(char: string): string {
  return char.replace(/[.*+?^${}()|[\]\\]/, "\\$&");
}

/** True when any exclude pattern matches the logical path. */
export function isExcluded(logicalPath: string, patterns: string[]): boolean {
  const normalized = logicalPath.replace(/\\/g, "/");
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

/** Split a file list into kept and excluded paths. */
export function partitionExcluded(
  logicalPaths: string[],
  patterns: string[],
): { kept: string[]; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const path of logicalPaths) {
    if (isExcluded(path, patterns)) {
      excluded.push(path);
    } else {
      kept.push(path);
    }
  }
  return { kept, excluded };
}
