/**
 * Detects dangerous bash commands and classifies them into risk tiers.
 *
 * Two tiers of dangerous commands:
 * - **restricted** — always blocked (no prompt, even in interactive mode):
 *   mkfs, dd disk imaging, fork bombs, chmod 777, chown, redirect to
 *   non-safe device files.
 * - **elevated**   — prompt in interactive mode, block in non-interactive:
 *   rm -r/f (recursive force), sudo invocations.
 *
 * Patterns are compiled once at module load. All matching is case-insensitive.
 */

import type { RiskTier } from "./types.ts";

// ---------------------------------------------------------------------------
// Individual pattern definitions
// ---------------------------------------------------------------------------

interface PatternDef {
  /** Human-readable label for logging / reason display */
  label: string;
  /** Compiled regex (case-insensitive) */
  regex: RegExp;
}

// --- Restricted (always block) ---

const RESTRICTED_PATTERNS: PatternDef[] = [
  // chmod 777 (any variant including octal with leading zeros)
  // Matches: chmod 777, chmod 0777, /bin/chmod -R 777
  { label: "chmod 777", regex: /\bchmod\b\s+.*\b0*777\b/i },

  // chown (any invocation — changes file ownership)
  { label: "chown", regex: /\bchown\b/i },

  // mkfs (filesystem creation — irreversible)
  { label: "mkfs", regex: /\bmkfs\b/i },

  // dd with if= or of= (disk imaging / cloning)
  { label: "dd disk", regex: /\bdd\s+.*(?:if=|of=)/i },

  // fork bomb — match the literal string pattern
  { label: "fork bomb", regex: /:\(\)\s*\{\s*:\s*\|[:\s]*:\s*&\s*\};?\s*:/i },

  // Redirect to /dev/ files EXCEPT the safe pseudo-devices:
  // null, zero, random, urandom, full, stderr, stdout, stdin, fd/, tty, ptmx
  {
    label: "redirect to device",
    regex:
      />\s*\/dev\/(?!null\b|zero\b|random\b|urandom\b|full\b|stderr\b|stdout\b|stdin\b|fd\/|tty\b|ptmx\b)/i,
  },

  // shred — secure deletion (irreversible)
  { label: "shred", regex: /\bshred\b/i },
];

// --- Elevated (prompt in interactive) ---

const ELEVATED_PATTERNS: PatternDef[] = [
  // rm with -r, -R, -f, --recursive, --force flags
  // Catches: rm -rf, rm -r -f, rm --recursive, rm -fr, /bin/rm -rf
  {
    label: "recursive rm",
    regex: /\brm\b\s+(?:--recursive|--force|-[a-zA-Z]*[rfR][a-zA-Z]*)/i,
  },

  // sudo (any invocation)
  { label: "sudo", regex: /\bsudo\b/i },
];

// --- Combined for isDangerousCommand (backward-compatible) ---

/** All patterns — restricted + elevated — for simple danger check. */
const ALL_PATTERNS: PatternDef[] = [...RESTRICTED_PATTERNS, ...ELEVATED_PATTERNS];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` if the command matches any dangerous pattern (either tier).
 */
export function isDangerousCommand(command: string): boolean {
  return ALL_PATTERNS.some((p) => p.regex.test(command));
}

/**
 * Classify a bash command into a risk tier with reasons.
 *
 * Returns `null` if no dangerous patterns match.
 */
export function classifyCommand(command: string): { tier: RiskTier; reasons: string[] } | null {
  const reasons: string[] = [];
  let tier: RiskTier | null = null;

  // Check restricted patterns first (they take priority)
  for (const p of RESTRICTED_PATTERNS) {
    if (p.regex.test(command)) {
      reasons.push(p.label);
      tier = "restricted";
    }
  }

  // Check elevated patterns
  for (const p of ELEVATED_PATTERNS) {
    if (p.regex.test(command)) {
      reasons.push(p.label);
      if (tier !== "restricted") tier = "elevated";
    }
  }

  if (tier === null) return null;
  return { tier, reasons };
}

// ---------------------------------------------------------------------------
// Re-exports for testing
// ---------------------------------------------------------------------------

export { RESTRICTED_PATTERNS, ELEVATED_PATTERNS, ALL_PATTERNS };
