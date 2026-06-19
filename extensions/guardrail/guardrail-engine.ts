/**
 * Pure classification engine for the guardrail extension.
 *
 * Takes a tool call (name + input), the working directory, and cached
 * .agentignore patterns, and returns a {@link Classification} describing
 * whether and why the operation needs guarding.
 *
 * This module is entirely pure — no pi SDK imports, no side effects, no UI.
 * Testable with plain Node.js test runner without any pi runtime.
 */

import { resolve } from "node:path";

import type { Classification, RiskTier } from "./types.ts";

import { isProtectedPath } from "./protected-paths.ts";
import { isProtectedByAgentIgnore, type AgentIgnorePatterns } from "./agentignore.ts";
import { classifyCommand } from "./dangerous-commands.ts";

// ---------------------------------------------------------------------------
// Path extraction helpers
// ---------------------------------------------------------------------------

/** Extract a target path from a tool call's input, if present. */
function getPath(input: Record<string, unknown>): string | undefined {
  const p = input.path;
  if (typeof p !== "string" || p.length === 0) return undefined;
  return p;
}

/** Extract a bash command from a tool call's input, if present. */
function getCommand(input: Record<string, unknown>): string | undefined {
  const c = input.command;
  if (typeof c !== "string" || c.length === 0) return undefined;
  return c;
}

/** Resolve a raw path to absolute, normalizing if needed. */
function resolvePath(raw: string, cwd: string): string {
  try {
    return resolve(cwd, raw);
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Individual classifiers
// ---------------------------------------------------------------------------

function classifyBash(
  command: string,
  cwd: string,
  agentIgnorePatterns: AgentIgnorePatterns | null,
): Classification | null {
  const cmdClass = classifyCommand(command);
  const reasons: string[] = [];
  let tier: RiskTier | null = null;
  let targetPath: string | undefined = undefined;

  // Check dangerous command patterns
  if (cmdClass) {
    reasons.push(...cmdClass.reasons.map((r) => `matches pattern: ${r}`));
    tier = cmdClass.tier;
  }

  // Check for paths in the command string that target protected paths
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  for (const token of tokens) {
    const trimmed = token.replace(/^["']|["']$/g, "");
    // Skip flags, pipes, and obvious non-paths
    if (
      trimmed.startsWith("-") ||
      trimmed === "|" ||
      trimmed === ";" ||
      trimmed === "&&" ||
      trimmed === "||"
    )
      continue;

    const resolved = resolvePath(trimmed, cwd);

    // Always-protected paths (.git/, .pi/)
    if (isProtectedPath(resolved)) {
      reasons.push(`targets protected path: ${trimmed}`);
      tier = "restricted";
      targetPath = resolved;
      break; // once blocked, stop scanning
    }

    // .agentignore patterns
    if (agentIgnorePatterns && isProtectedByAgentIgnore(resolved, agentIgnorePatterns, cwd)) {
      reasons.push(`targets agentignore path: ${trimmed}`);
      if (tier !== "restricted") tier = "elevated";
      targetPath = resolved;
    }
  }

  if (tier === null) return null;

  return {
    tier,
    toolName: "bash",
    reasons,
    targetPath,
    command,
  };
}

function classifyPathTool(
  toolName: "read" | "write" | "edit",
  rawPath: string,
  cwd: string,
  agentIgnorePatterns: AgentIgnorePatterns | null,
): Classification | null {
  const resolved = resolvePath(rawPath, cwd);
  const reasons: string[] = [];
  let tier: RiskTier | null = null;

  // 1. Always-protected paths (.git/, .pi/) — restricted for write/edit, elevated for read
  if (isProtectedPath(resolved)) {
    reasons.push(`targets protected path: ${rawPath}`);
    tier = toolName === "read" ? "elevated" : "restricted";
  }

  // 2. .agentignore patterns — elevated for all
  if (agentIgnorePatterns && isProtectedByAgentIgnore(resolved, agentIgnorePatterns, cwd)) {
    reasons.push(`matches .agentignore pattern: ${rawPath}`);
    tier = tier === "restricted" ? "restricted" : "elevated";
  }

  if (tier === null) return null;

  return {
    tier,
    toolName,
    reasons,
    targetPath: resolved,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a tool call for guardrail purposes.
 *
 * @param toolName - Which pi tool is being called.
 * @param input    - The tool's input parameters (mutable from `tool_call` event).
 * @param cwd      - Current working directory.
 * @param agentIgnorePatterns - Cached .agentignore patterns, or null if none.
 * @returns A Classification if the call needs guarding, or null if it's safe.
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  agentIgnorePatterns: AgentIgnorePatterns | null,
): Classification | null {
  // Only guard known tool types
  if (toolName === "bash") {
    const command = getCommand(input);
    if (!command) return null;
    return classifyBash(command, cwd, agentIgnorePatterns);
  }

  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    const rawPath = getPath(input);
    if (!rawPath) return null;
    return classifyPathTool(toolName, rawPath, cwd, agentIgnorePatterns);
  }

  // Unknown tool — no guard needed
  return null;
}
