/**
 * Guardrail Extension for pi-agent
 *
 * Intercepts tool calls and blocks dangerous operations before they execute.
 * Two tiers of protection:
 *
 * 1. **Dangerous Bash Commands** — interactive confirm (hasUI) or auto-block
 * 2. **Protected File Paths** — `.git/` and `.pi/` always blocked, plus optional
 *    `.agentignore` patterns
 *
 * See docs/dev/spec-guardrail-extension.md for the full specification.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isDangerousCommand } from "./dangerous-commands";
import { isProtectedPath } from "./protected-paths";
import {
  findAgentIgnoreFile,
  parseAgentIgnore,
  isProtectedByAgentIgnore,
  type AgentIgnorePatterns,
} from "./agentignore";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Cached .agentignore patterns (keyed by cwd)
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
// Test helper — clears the .agentignore cache
// ---------------------------------------------------------------------------

export function clearAgentIgnoreCache(): void {
  agentIgnoreCache.clear();
}

// ---------------------------------------------------------------------------
// Bash command path checking
// ---------------------------------------------------------------------------

/**
 * Check whether a bash command targets any protected file paths.
 * Extracts whitespace-delimited tokens that look like file paths and
 * checks them against always-protected paths and .agentignore patterns.
 */
function commandTargetsProtectedPath(
  command: string,
  cwd: string,
  agentIgnorePatterns: AgentIgnorePatterns | null,
): string | null {
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);

  for (const token of tokens) {
    const trimmed = token.replace(/^["']|["']$/g, "");
    // Skip flags and obvious non-paths
    if (
      trimmed.startsWith("-") ||
      trimmed.startsWith("--") ||
      trimmed === "|" ||
      trimmed === ";" ||
      trimmed === "&&" ||
      trimmed === "||"
    )
      continue;

    // Resolve relative to cwd
    let resolved: string;
    try {
      resolved = resolve(cwd, trimmed);
    } catch {
      continue;
    }

    // Check always-protected
    if (isProtectedPath(resolved, cwd)) {
      return resolved;
    }

    // Check .agentignore
    if (agentIgnorePatterns && isProtectedByAgentIgnore(resolved, agentIgnorePatterns, cwd)) {
      return resolved;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  // --- Bash guardrail ---
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string }).command;
    if (!command) return;

    const isDangerous = isDangerousCommand(command);
    const agentIgnorePatterns = getAgentIgnorePatterns(ctx.cwd);
    const targetedPath = commandTargetsProtectedPath(command, ctx.cwd, agentIgnorePatterns);

    if (!isDangerous && !targetedPath) return;

    // Build the reason
    const reasons: string[] = [];
    if (isDangerous) reasons.push("dangerous command pattern");
    if (targetedPath) reasons.push(`targets protected path: ${targetedPath}`);
    const reason = reasons.join("; ");

    if (ctx.hasUI) {
      const details = [
        isDangerous ? "⚠️  Dangerous command pattern detected" : "",
        targetedPath ? `🛡️  Targets protected path: ${targetedPath}` : "",
        `\nCommand: ${command}`,
      ]
        .filter(Boolean)
        .join("\n");

      // Notify user via the extension event bus (picked up by notify.ts)
      pi.events.emit("user-input-needed", {
        title: "Pi — Guardrail",
        body: `Block or Allow? — ${command.slice(0, 60)}`,
      });

      const choice = await ctx.ui.select(details, ["Block", "Allow"]);
      if (choice === "Block") {
        return { block: true, reason: `Blocked by user: ${reason}` };
      }
    } else {
      return { block: true, reason: `Blocked (no UI): ${reason}` };
    }
  });

  // --- Path guardrail (write and edit) ---
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    const targetPath = (event.input as { path?: string }).path;
    if (!targetPath) return;

    // 1. Always-blocked paths (.git/, .pi/)
    if (isProtectedPath(targetPath, ctx.cwd)) {
      ctx.ui.notify(`Blocked ${event.toolName} to protected path: ${targetPath}`, "warning");
      return { block: true, reason: "Path is protected" };
    }

    // 2. .agentignore patterns (if any)
    const patterns = getAgentIgnorePatterns(ctx.cwd);
    if (patterns && isProtectedByAgentIgnore(targetPath, patterns, ctx.cwd)) {
      ctx.ui.notify(
        `Blocked ${event.toolName} to agentignore-protected path: ${targetPath}`,
        "warning",
      );
      return { block: true, reason: "Path is protected by .agentignore" };
    }
  });
}
