/**
 * UI interaction handlers for the guardrail extension.
 *
 * Takes a {@link Classification} from the pure engine and resolves it into
 * a {@link Decision} (allow / block / prompt), handling both interactive
 * (TUI/RPC) and non-interactive (print/JSON) modes.
 *
 * This module imports from the pi SDK for UI interaction but keeps all
 * business logic in the pure modules.
 */

import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Classification, Decision } from "./types.ts";

// ---------------------------------------------------------------------------
// Session-scoped allowlist helpers
// ---------------------------------------------------------------------------

/** Restore previously persisted allowed paths from session entries. */
export function restoreAllowedPaths(ctx: ExtensionContext): Set<string> {
  const allowed = new Set<string>();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "guardrail-allowed-path") {
      const p = (entry.data as { path?: string })?.path;
      if (p) allowed.add(p);
    }
  }
  return allowed;
}

/** Check whether a resolved absolute path (or any ancestor) has been allowed. */
export function isPathAllowed(resolved: string, allowedPaths: Set<string>): boolean {
  if (allowedPaths.has(resolved)) return true;

  let dir = resolved;
  while (true) {
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
    if (allowedPaths.has(dir)) return true;
  }

  return false;
}

/** Persist an allowed path in memory and to the session file. */
export function allowPath(path: string, pi: ExtensionAPI, allowedPaths: Set<string>): void {
  allowedPaths.add(path);
  pi.appendEntry("guardrail-allowed-path", { path });
}

// ---------------------------------------------------------------------------
// Decision resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a classification into a decision.
 *
 * - `restricted` tier → always block (no prompt).
 * - `elevated` tier in interactive mode → prompt with Allow / Block.
 * - `elevated` tier in non-interactive mode → block by default.
 * - `safe` tier → allow (should not reach here; engine returns null for safe).
 * - For read operations, checks session allowlist before prompting.
 *
 * Emits `user-input-needed` on the extension event bus when a dialog is
 * about to be shown (for desktop notification integration).
 */
export async function resolveDecision(
  classification: Classification,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  allowedPaths: Set<string>,
): Promise<Decision> {
  const { tier, toolName, reasons, targetPath, command } = classification;

  // Restricted tier — always block
  if (tier === "restricted") {
    const reason = `Blocked: ${reasons.join("; ")}`;
    if (toolName !== "bash" && targetPath) {
      ctx.ui.notify(`Blocked ${toolName} to protected path: ${targetPath}`, "warning");
    }
    return { action: "block", reason };
  }

  // Elevated tier — requires UI or auto-block
  if (tier === "elevated") {
    // For read operations: check session allowlist first
    if (toolName === "read" && targetPath && isPathAllowed(targetPath, allowedPaths)) {
      return { action: "allow" };
    }

    // Non-interactive mode: block by default (fail-safe)
    if (!ctx.hasUI) {
      const reason = `Blocked (no UI): ${reasons.join("; ")}`;
      return { action: "block", reason };
    }

    // Interactive mode: prompt the user
    try {
      // Emit desktop notification event so the user knows pi is waiting
      const notifyTitle = toolName === "bash" ? `Pi — Dangerous command` : `Pi — Protected path`;
      const notifyBody =
        toolName === "bash" ? (command ?? "").slice(0, 60) : (targetPath ?? "").slice(-50);

      pi.events.emit("user-input-needed", {
        title: notifyTitle,
        body: notifyBody,
      });

      // Build the prompt message
      const details = buildPromptMessage(classification);

      // For bash: Allow / Block
      // For read/write/edit: Allow once / Block
      const options = ["Block", "Allow"];
      const choice = await ctx.ui.select(details, options);

      if (choice === "Block" || choice === undefined) {
        return { action: "block", reason: `Blocked by user: ${reasons.join("; ")}` };
      }

      // User allowed — for read operations, remember the path
      if (toolName === "read" && targetPath) {
        allowPath(targetPath, pi, allowedPaths);
      }

      return { action: "allow" };
    } catch (err) {
      // UI failure — fail safe by blocking
      console.error("[guardrail] UI interaction failed:", err);
      return { action: "block", reason: `Guardrail UI error: ${reasons.join("; ")}` };
    }
  }

  // Safe tier — should not reach here (engine returns null for safe)
  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// Prompt message builder
// ---------------------------------------------------------------------------

function buildPromptMessage(c: Classification): string {
  const parts: string[] = [];

  if (c.toolName === "bash" && c.command) {
    parts.push(`⚠️  Dangerous command detected`);
    if (c.targetPath) {
      parts.push(`🛡️  Targets protected path: ${c.targetPath}`);
    }
    parts.push(`\nCommand: ${c.command}`);
  } else if (c.targetPath) {
    parts.push(`🛡️  Protected path: ${c.targetPath}`);
    parts.push(`\nAllow ${c.toolName}?`);
  }

  return parts.join("\n");
}
