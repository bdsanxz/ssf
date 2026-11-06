// Secret scanner for CI and local use.
// Scans tracked text files for common secret patterns and fails when found.
// This is a deterrent and hygiene gate, not a replacement for a dedicated scanner.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execSync } from "node:child_process";

const PATTERNS = [
  { name: "pem-private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "github-token", re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  // Quoted values (>=16 chars) are the classic committed-secret shape; bare
  // tokens need >=32 chars so identifier calls like rootSecret: generateRootSecret()
  // do not false-positive. Dedicated patterns above cover short token formats.
  { name: "generic-api-key", re: /(api[_-]?key|secret|root[_-]?secret)\s*[:=]\s*('[^']{16,}'|"[^"]{16,}"|[A-Za-z0-9_\-]{32,})/i },
  { name: "license-token", re: /ssf1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
];

const ALLOWLIST_FILES = new Set([
  "scripts/scan-secrets.mjs",
  "qa/fixtures/secrets.fixture.txt",
]);

// Build-output and dependency directories are never scanned, whether they
// are reached through the filesystem walk or listed as tracked files.
const SKIP_DIRS = new Set(["node_modules", ".git", ".turbo", "dist", ".next", "coverage", ".DS_Store"]);

/** True when any path segment is a skipped build-output directory. */
function isSkippedPath(path) {
  return path.split("/").some((segment) => SKIP_DIRS.has(segment));
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(relative(".", full));
  }
  return out;
}

function listFiles() {
  try {
    const out = execSync("git ls-files", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\n").map((s) => s.trim()).filter(Boolean);
    if (files.length > 0) return files;
  } catch {
    // Fall through to filesystem walk below.
  }
  return walk(".");
}

function isTextFile(path) {
  return !/\.(png|jpg|jpeg|gif|webp|ico|pdf|zip|tar\.gz|node|cbor|bin)$/i.test(path);
}

let failures = 0;
for (const file of listFiles()) {
  if (ALLOWLIST_FILES.has(file)) continue;
  if (isSkippedPath(file)) continue;
  if (!isTextFile(file)) continue;
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    if (re.test(content)) {
      console.error(`secret pattern detected: ${name} in ${file}`);
      failures += 1;
      break;
    }
  }
}

if (failures > 0) {
  console.error(`scan-secrets: ${failures} file(s) with suspected secrets. Remove secrets and retry.`);
  process.exit(1);
}

console.log("scan-secrets: no secret patterns found.");
