/**
 * Detects whether a file path targets a protected directory.
 *
 * Two tiers of protection:
 * 1. Always protected: `.git/` and `.pi/` (non-negotiable)
 * 2. Optional: `.agentignore` patterns (implemented in agentignore.ts)
 */

/**
 * Paths that are always blocked for write/edit operations.
 * The trailing `/` ensures we match directory entries, not filenames
 * that happen to contain these substrings (e.g. `.gitignore`, `digit.ts`).
 */
export const ALWAYS_PROTECTED = [".git/", ".pi/"] as const;

/**
 * Returns `true` if the path targets a protected directory.
 *
 * The check is a simple substring match against the path string
 * (both relative and absolute paths work). The trailing `/` in
 * each protected entry prevents false positives on filenames
 * like `.gitignore` or `spinner.ts`.
 */
export function isProtectedPath(path: string, _cwd: string): boolean {
  return ALWAYS_PROTECTED.some((entry) => path.includes(entry));
}
