/**
 * Shared types for the guardrail extension.
 *
 * Separated to keep pure logic modules free of pi SDK imports
 * and to provide a single source of truth for contracts between modules.
 */

// ---------------------------------------------------------------------------
// Tool names we guard
// ---------------------------------------------------------------------------

export type GuardedTool = "bash" | "read" | "write" | "edit";

export const GUARDED_TOOLS: readonly GuardedTool[] = ["bash", "read", "write", "edit"];

// ---------------------------------------------------------------------------
// Risk tiers
// ---------------------------------------------------------------------------

/**
 * Classification tiers for tool calls:
 *
 * - `safe`       — auto-allow, no prompt (e.g., read-only, locally scoped).
 * - `elevated`   — prompt in interactive mode, block in non-interactive.
 * - `restricted` — always block (non-negotiable paths, mkfs, fork bombs).
 */
export type RiskTier = "safe" | "elevated" | "restricted";

// ---------------------------------------------------------------------------
// Classification result
// ---------------------------------------------------------------------------

/**
 * Produced by the pure classification engine. Describes *why* a tool call
 * needs guarding, without prescribing what to do about it.
 */
export interface Classification {
  /** Risk tier for this tool call */
  tier: RiskTier;

  /** Which tool is being called */
  toolName: GuardedTool;

  /** Human-readable reasons for the classification */
  reasons: string[];

  /** Resolved absolute path targeted by the operation, if applicable */
  targetPath?: string;

  /** The bash command string, if applicable */
  command?: string;
}

// ---------------------------------------------------------------------------
// Decision (returned after UI interaction or auto-resolution)
// ---------------------------------------------------------------------------

export type Decision =
  | { action: "allow" }
  | { action: "block"; reason: string }
  | { action: "prompt"; classification: Classification };

// ---------------------------------------------------------------------------
// Guardrail configuration
// ---------------------------------------------------------------------------

export interface GuardrailConfig {
  /**
   * Paths that are always blocked for write/edit operations.
   * Entries must end with `/` to anchor to directories.
   */
  alwaysProtected: readonly string[];
}

/** Default paths that are non-negotiable. */
export const DEFAULT_ALWAYS_PROTECTED = [".git/", ".pi/"] as const;
