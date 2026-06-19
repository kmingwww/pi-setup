/**
 * .agentignore file support for the guardrail extension.
 *
 * Reads a gitignore-style file from the project tree and provides
 * pattern matching to protect additional file paths beyond the
 * hardcoded `.git/` and `.pi/` entries.
 */

import { existsSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentIgnorePatterns {
  /** Patterns to include (block) */
  include: string[];
  /** Patterns to exclude (allow) via ! negation */
  exclude: string[];
}

// ---------------------------------------------------------------------------
// findAgentIgnoreFile
// ---------------------------------------------------------------------------

/**
 * Walks up from `cwd` to the filesystem root looking for a `.agentignore` file.
 * Returns the full path to the first one found, or `null` if none exists.
 */
export function findAgentIgnoreFile(cwd: string): string | null {
  let dir = resolve(cwd);

  while (true) {
    const candidate = dir + sep + ".agentignore";
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// parseAgentIgnore
// ---------------------------------------------------------------------------

/**
 * Parses a `.agentignore` file content into include and exclude pattern lists.
 *
 * Format follows `.gitignore` conventions:
 * - One pattern per line
 * - `#` starts a comment (must be at the beginning of the line;
 *   inline comments like `pattern # note` are NOT supported and
 *   will treat the entire line as a literal pattern)
 * - `!` prefix negates (allowlists) the pattern
 * - Blank lines are ignored
 * - Leading/trailing whitespace is trimmed
 */
export function parseAgentIgnore(content: string): AgentIgnorePatterns {
  const include: string[] = [];
  const exclude: string[] = [];

  for (let line of content.split("\n")) {
    line = line.trim();

    // Skip blank lines and comments
    if (line.length === 0 || line.startsWith("#")) continue;

    // Negation pattern (allowlist)
    if (line.startsWith("!")) {
      exclude.push(line.slice(1).trim());
    } else {
      include.push(line);
    }
  }

  return { include, exclude };
}

// ---------------------------------------------------------------------------
// isProtectedByAgentIgnore
// ---------------------------------------------------------------------------

/**
 * Checks whether a path should be protected based on `.agentignore` patterns.
 *
 * The path is first resolved against `baseDir`. Then:
 * 1. Exclude patterns (allowlist) are checked first — if any match, the path is NOT protected.
 * 2. Include patterns are checked — if any match, the path IS protected.
 * 3. If no patterns match, the path is NOT protected.
 *
 * Pattern matching uses glob-style syntax: `*` matches any sequence except `/`,
 * trailing `/` anchors to directories only.
 */
export function isProtectedByAgentIgnore(
  rawPath: string,
  patterns: AgentIgnorePatterns,
  baseDir: string,
): boolean {
  // Resolve to an absolute path
  const absolute = rawPath.startsWith("/") ? rawPath : resolve(baseDir, rawPath);
  const relative = toRelative(absolute, baseDir);

  // Exclusion (allowlist) patterns take priority
  for (const pattern of patterns.exclude) {
    if (matchGitignorePattern(relative, pattern)) return false;
  }

  // Inclusion (blocklist) patterns
  for (const pattern of patterns.include) {
    if (matchGitignorePattern(relative, pattern)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Pattern matching (simplified gitignore semantics)
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to a relative path from baseDir.
 * Handles edge cases like the path being the baseDir itself.
 */
function toRelative(absolute: string, baseDir: string): string {
  const normalizedBase = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (absolute === baseDir) return "";
  if (absolute.startsWith(normalizedBase)) return absolute.slice(normalizedBase.length);
  return absolute; // path is outside baseDir, match against full path
}

/**
 * Match a relative path against a single gitignore-style pattern.
 *
 * Simplified semantics:
 * - `*` matches anything except `/`
 * - `** / **` matches any number of path segments (including zero)
 * - Trailing `/` anchors to directories only (the path must be a directory entry)
 * - Otherwise, the pattern is anchored to the path as a "contains" match
 */
function matchGitignorePattern(relative: string, pattern: string): boolean {
  // Convert gitignore pattern to regex
  const regex = gitignorePatternToRegex(pattern);
  return regex.test(relative);
}

/**
 * Convert a gitignore-style pattern to a RegExp.
 *
 * Handles:
 * - `*` → `[^/]*` (match within a single path segment)
 * - `** / **` → `.*` (match across path segments, including zero)
 * - Trailing `/` → match directory prefix
 * - Escapes special regex characters: `.`, `+`, `^`, `$`, `{`, `}`, `(`, `)`, `[`, `]`, `|`
 */
function gitignorePatternToRegex(pattern: string): RegExp {
  let regexStr = "";

  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === "*" && pattern[i + 1] === "*" && (i === 0 || pattern[i - 1] === "/")) {
      // ** — match across segments
      regexStr += ".*";
      i += 2;
      // Skip trailing /
      if (pattern[i] === "/") i++;
    } else if (ch === "*") {
      regexStr += "[^/]*";
      i++;
    } else if (".[](){}^$|+\\".includes(ch)) {
      regexStr += "\\" + ch;
      i++;
    } else {
      regexStr += ch;
      i++;
    }
  }

  // If pattern ends with /, anchor to directories
  if (pattern.endsWith("/")) {
    // Match the pattern as a prefix of any path segment
    return new RegExp("(^|/)" + regexStr);
  }

  // Match the pattern anywhere in the path (as a filename or path segment)
  return new RegExp("(^|/)" + regexStr + "$");
}
