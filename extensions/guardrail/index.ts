/**
 * Guardrail Extension for pi-agent
 *
 * Intercepts tool calls (bash, read, write, edit) and blocks dangerous
 * operations before they execute.
 *
 * Three tiers of protection:
 * 1. **Dangerous Bash Commands** — restricted (e.g., mkfs, chmod 777) are
 *    always blocked; elevated (e.g., rm -rf, sudo) prompt in interactive mode.
 * 2. **Protected File Paths** — `.git/` and `.pi/` are always blocked for
 *    write/edit, and prompt for read.
 * 3. **.agentignore Patterns** — additional project-defined paths using
 *    gitignore syntax. Prompt for read, block for write/edit.
 *
 * Architecture: pure classification engine (guardrail-engine.ts) + UI glue
 * (ui-handlers.ts) = thin event wiring (this file).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";

import { GUARDED_TOOLS } from "./types.ts";
import { findAgentIgnoreFile, parseAgentIgnore } from "./agentignore.ts";
import { classifyToolCall } from "./guardrail-engine.ts";
import { resolveDecision, restoreAllowedPaths, isPathAllowed } from "./ui-handlers.ts";

// ---------------------------------------------------------------------------
// .agentignore cache (keyed by cwd)
// ---------------------------------------------------------------------------

const agentIgnoreCache = new Map<string, ReturnType<typeof parseAgentIgnore> | null>();

function getAgentIgnorePatterns(cwd: string) {
  if (agentIgnoreCache.has(cwd)) {
    return agentIgnoreCache.get(cwd)!;
  }

  const filePath = findAgentIgnoreFile(cwd);
  if (!filePath) {
    agentIgnoreCache.set(cwd, null);
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const patterns = parseAgentIgnore(content);
    agentIgnoreCache.set(cwd, patterns);
    return patterns;
  } catch {
    agentIgnoreCache.set(cwd, null);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // Session-scoped allowlist: paths the user has explicitly allowed for read.
  const allowedPaths = new Set<string>();

  /** Restore allowlist from previously persisted session entries. */
  pi.on("session_start", async (_event, ctx) => {
    const restored = restoreAllowedPaths(ctx);
    for (const p of restored) allowedPaths.add(p);
  });

  /**
   * Single tool_call handler with error boundary.
   *
   * If the guardrail itself throws, we fail-safe by blocking the operation
   * rather than letting the error propagate and potentially hang the agent.
   */
  pi.on("tool_call", async (event, ctx) => {
    try {
      const toolName = event.toolName;

      // Only guard known tool types
      if (!(GUARDED_TOOLS as readonly string[]).includes(toolName)) return;

      const patterns = getAgentIgnorePatterns(ctx.cwd);
      const classification = classifyToolCall(
        toolName,
        event.input as Record<string, unknown>,
        ctx.cwd,
        patterns,
      );

      if (!classification) return;

      // For read operations: check session allowlist before prompting
      if (
        toolName === "read" &&
        classification.targetPath &&
        isPathAllowed(classification.targetPath, allowedPaths)
      ) {
        return;
      }

      const decision = await resolveDecision(classification, ctx, pi, allowedPaths);

      if (decision.action === "block") {
        return { block: true, reason: decision.reason };
      }
      // "allow" or "prompt" — let the tool execute
    } catch (err) {
      // Fail-safe: if guardrail crashes, block the operation
      console.error("[guardrail] Error in tool_call handler:", err);
      return {
        block: true,
        reason: "Guardrail internal error — operation blocked for safety",
      };
    }
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Clears the .agentignore file cache. For testing only. */
export function clearAgentIgnoreCache(): void {
  agentIgnoreCache.clear();
}
