/**
 * Detects whether a file path targets a protected directory.
 *
 * Uses path-segment matching rather than naive substring matching to
 * avoid false positives on paths like `my.git-helper/config` or
 * `spinner.ts` when checking for `.git/` or `.pi/`.
 *
 * Two tiers of protection:
 * 1. Always protected: `.git/` and `.pi/` (non-negotiable)
 * 2. Optional: `.agentignore` patterns (implemented in agentignore.ts)
 */

import { sep } from "node:path";
import { DEFAULT_ALWAYS_PROTECTED } from "./types.ts";

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

/**
 * Split a path into normalized segments.
 * Handles both Unix and Windows separators, and collapses redundant separators.
 */
function segments(absolutePath: string): string[] {
  // Normalize separators and split
  return absolutePath
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s.length > 0);
}

/**
 * Check if `segments` contains all of `needle` as a contiguous subsequence.
 */
function containsSequence(segments: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  if (needle.length > segments.length) return false;

  outer: for (let i = 0; i <= segments.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (segments[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the absolute path targets any of the always-protected
 * directories (`.git/`, `.pi/`).
 *
 * Matching is done by path segments: `/foo/.git/HEAD` matches `.git/`,
 * but `/foo/my.git-helper/config` does NOT.
 *
 * The path is expected to already be resolved to an absolute path.
 */
export function isProtectedPath(absolutePath: string): boolean {
  const pathSegs = segments(absolutePath);

  for (const protected_ of DEFAULT_ALWAYS_PROTECTED) {
    // Strip trailing `/` for segment matching
    const protectedName = protected_.endsWith(sep + "")
      ? protected_.slice(0, -1)
      : protected_.replace(/\/$/, "");

    const needle = protectedName.split("/");

    if (containsSequence(pathSegs, needle)) return true;
  }

  return false;
}
