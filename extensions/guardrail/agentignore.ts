/**
 * .agentignore file support for the guardrail extension.
 *
 * Reads a gitignore-style file from the project tree (stopping at the git
 * root) and provides pattern matching to protect additional file paths
 * beyond the hardcoded `.git/` and `.pi/` entries.
 *
 * Pattern matching follows gitignore semantics as closely as practical
 * without external dependencies:
 * - `*` matches anything except `/`
 * - `?` matches any single character except `/`
 * - `[abc]` matches single characters in the range
 * - `**` matches zero or more directory segments
 * - Leading `/` anchors to the directory of the .agentignore file
 * - Trailing `/` anchors to directories only
 * - `!` prefix negates (allowlists) the pattern
 * - `#` starts a comment
 * - Blank lines are ignored
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
 * Walks up from `cwd` looking for a `.agentignore` file.
 * Stops at the git root (the nearest ancestor containing a `.git/` directory)
 * or the filesystem root, whichever is encountered first.
 *
 * Returns the full path to the first `.agentignore` found, or `null`.
 */
export function findAgentIgnoreFile(cwd: string): string | null {
  let dir = resolve(cwd);

  while (true) {
    const candidate = dir + sep + ".agentignore";
    if (existsSync(candidate)) return candidate;

    // Stop at git root
    if (existsSync(dir + sep + ".git")) return null;

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
 * - `#` starts a comment (must be at the beginning of the line)
 * - `!` prefix negates (allowlists) the pattern
 * - Blank lines are ignored
 * - Leading/trailing whitespace is trimmed
 * - Trailing `\` escapes a trailing space
 */
export function parseAgentIgnore(content: string): AgentIgnorePatterns {
  const include: string[] = [];
  const exclude: string[] = [];

  for (let line of content.split("\n")) {
    // gitignore: trailing spaces are ignored unless quoted with backslash.
    // The backslash is consumed as an escape, not part of the pattern.
    const hasEscapedSpace = /\\ $/.test(line);
    line = line.trim();
    if (hasEscapedSpace) line = line.replace(/\\$/, " ");

    // Skip blank lines and comments
    if (line.length === 0 || line.startsWith("#")) continue;

    // Negation pattern (allowlist)
    if (line.startsWith("!")) {
      const negated = line.slice(1).trim();
      if (negated.length > 0) exclude.push(negated);
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
 * 1. Exclude (allowlist) patterns are checked first — if any match, the path
 *    is NOT protected.
 * 2. Include (blocklist) patterns are checked — if any match, the path IS
 *    protected.
 * 3. If no patterns match, the path is NOT protected.
 *
 * The `rawPath` is resolved against `baseDir` (the directory containing the
 * `.agentignore` file). Patterns with a leading `/` are anchored to `baseDir`.
 */
export function isProtectedByAgentIgnore(
  rawPath: string,
  patterns: AgentIgnorePatterns,
  baseDir: string,
): boolean {
  // Resolve to an absolute path, then convert to relative from baseDir
  const absolute = rawPath.startsWith("/") ? rawPath : resolve(baseDir, rawPath);
  const relative = makeRelative(absolute, baseDir);
  if (relative === null) return false; // path is entirely outside baseDir

  // Exclusion (allowlist) patterns take priority
  for (const pattern of patterns.exclude) {
    if (matchesGitignore(relative, pattern, false)) return false;
  }

  // Inclusion (blocklist) patterns
  for (const pattern of patterns.include) {
    if (matchesGitignore(relative, pattern, false)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Convert an absolute path to a relative path from baseDir.
 * Returns `null` if the path is not under baseDir.
 */
function makeRelative(absolute: string, baseDir: string): string | null {
  const normalizedBase = baseDir.endsWith(sep) ? baseDir : baseDir + sep;
  if (absolute === baseDir) return "";
  if (absolute.startsWith(normalizedBase)) return absolute.slice(normalizedBase.length);
  return null; // path is outside baseDir — patterns should not match
}

// ---------------------------------------------------------------------------
// Gitignore pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a relative path against a single gitignore-style pattern.
 *
 * @param relative - Path relative to the .agentignore file's directory.
 * @param pattern - A gitignore-style pattern.
 * @param isDir   - Whether the path is known to be a directory.
 */
function matchesGitignore(relative: string, pattern: string, _isDir: boolean): boolean {
  // Trailing `/` anchors to directories only
  let dirOnly = false;
  let pat = pattern;

  if (pat.endsWith("/")) {
    dirOnly = true;
    pat = pat.slice(0, -1);
  }

  // Leading `/` anchors to the root of the .agentignore directory
  let anchored = false;
  if (pat.startsWith("/")) {
    anchored = true;
    pat = pat.slice(1);
  }

  const regex = patternToRegex(pat, anchored, dirOnly);
  const testPath = dirOnly ? relative + "/" : relative;
  return regex.test(testPath);
}

/**
 * Convert a gitignore pattern (without leading `/` or trailing `/` anchors —
 * those are handled by the caller) into a RegExp for testing against a
 * relative path.
 */
function patternToRegex(pattern: string, anchored: boolean, dirOnly = false): RegExp {
  let regexStr = anchored ? "^" : "(^|/)";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i] as string;
    const next = pattern[i + 1] as string | undefined;
    const next2 = pattern[i + 2] as string | undefined;
    const prev = pattern[i - 1] as string | undefined;

    // ** — match zero or more directory segments
    if (ch === "*" && next === "*") {
      // /**/ or leading **/ or trailing /**
      const isSlashBefore = prev === "/" || i === 0;
      const isSlashAfter = next2 === "/";

      if (isSlashBefore && isSlashAfter) {
        // foo/**/bar — match across segments
        regexStr += "(.*/)?";
        i += 3; // skip **/
      } else if (isSlashBefore && next2 === undefined) {
        // trailing /** — match everything inside
        regexStr += ".*";
        i += 2;
      } else if (i === 0 && next2 === "/") {
        // leading **/ — match in all directories
        regexStr += "(.*/)?";
        i += 3;
      } else {
        // Bare ** is unusual; treat as .*
        regexStr += ".*";
        i += 2;
        if (next2 === "/") i++; // skip trailing /
      }
    }
    // * — match anything except /
    else if (ch === "*") {
      regexStr += "[^/]*";
      i++;
    }
    // ? — match any single char except /
    else if (ch === "?") {
      regexStr += "[^/]";
      i++;
    }
    // [...] — character class (pass through literally)
    else if (ch === "[") {
      const close = pattern.indexOf("]", i);
      if (close !== -1) {
        regexStr += pattern.slice(i, close + 1);
        i = close + 1;
      } else {
        regexStr += "\\[";
        i++;
      }
    }
    // Escape regex special characters
    else if (".^$+{}()|\\".includes(ch)) {
      regexStr += "\\" + ch;
      i++;
    }
    // Literal character
    else {
      regexStr += ch;
      i++;
    }
  }

  // For directory-only patterns (handled by caller), match the segment as a
  // prefix — ending with either / or end-of-string.  This makes
  // "node_modules/" match "node_modules/api.js" and "src/node_modules/".
  if (dirOnly) {
    regexStr += "(\\/|$)";
  } else if (!regexStr.endsWith(".*")) {
    regexStr += "$";
  }

  return new RegExp(regexStr);
}

// ---------------------------------------------------------------------------
// Re-export matchesGitignore for testing
// ---------------------------------------------------------------------------

/**
 * Test helper — exposed so tests can verify individual pattern matching
 * without needing a full .agentignore parse.
 */
export function testMatchesGitignore(relative: string, pattern: string, isDir?: boolean): boolean {
  return matchesGitignore(relative, pattern, isDir ?? false);
}
