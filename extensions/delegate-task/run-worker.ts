/** Spawns a headless child AgentSession. Emits structured ToolLogEntry[] via onUpdate. */

import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import {
  DefaultResourceLoader,
  SessionManager,
  createAgentSession,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { AgentManager, findAgentFile, parseAgentFile } from "./agent-manager";
import { createAgentTools } from "./tools";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";

/** Truncate long strings, appending "…" when shortened. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Structured tool activity — facts only. Presentation lives in tools.ts renderResult. */
export interface ToolLogEntry {
  label: string;
  status: "running" | "done" | "error";
}

/** Content block type from the agent SDK — TextContent | ImageContent */
type ContentBlock = AgentToolResult<unknown>["content"][number];

/** Extract the last assistant text block from agent state. */
export function extractResult(state: Pick<AgentSession["agent"]["state"], "messages">): string {
  if (!state || !state.messages || state.messages.length === 0) {
    return "Task completed, but no text output was generated.";
  }

  for (let i = state.messages.length - 1; i >= 0; i--) {
    const msg = state.messages[i];
    if (!msg || msg.role !== "assistant" || !("content" in msg)) continue;
    const content = msg.content;
    if (typeof content === "string" || content.length === 0) continue;
    const textBlock = content.find(
      (c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text",
    );
    if (textBlock && typeof textBlock.text === "string") {
      const text = textBlock.text.trim();
      if (text) return text;
    }
  }

  return "Task completed, but no text output was generated.";
}

/**
 * Fire-and-forget async wrapper around runWorker.
 * Calls runWorker in the background and uses the followUp callback
 * to notify the parent session when complete (or on error).
 *
 * Never throws — errors are caught and reported via followUp.
 */
export function runWorkerAsync(
  task: string,
  agentType: string,
  parentId: string | null,
  mainSessionId: string,
  manager: AgentManager,
  followUp: (text: string) => Promise<void>,
  onUpdate?: (entries: ToolLogEntry[]) => void,
): void {
  // Fire and forget — intentionally not awaited
  void (async () => {
    try {
      const result = await runWorker(task, agentType, parentId, mainSessionId, manager, onUpdate);
      await followUp(`✅ ${agentType} done: ${truncate(result, 280)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await followUp(`❌ ${agentType} failed: ${truncate(message, 280)}`);
    }
  })();
}

export async function runWorker(
  task: string,
  agentType: string,
  parentId: string | null,
  mainSessionId: string,
  manager: AgentManager,
  onUpdate?: (entries: ToolLogEntry[]) => void,
): Promise<string> {
  const childAgentId = `agent-${crypto.randomUUID()}`;

  // Register the agent early so it's tracked even if initialization fails
  manager.register(childAgentId, parentId, agentType, task);

  let result = "Task failed or was aborted.";
  try {
    const contextPath = await findAgentFile(agentType);

    let rawContent = "You are a helpful background agent.";
    if (contextPath) {
      try {
        rawContent = await fs.readFile(contextPath, "utf-8");
      } catch {
        // Falls back to default
      }
    }

    const { body, tools } = parseAgentFile(rawContent);

    // Build custom tools for the child session.
    // - check_agent_statuses is always injected (read-only introspection, useful to all agents).
    // - delegate_task is only injected when the agent file explicitly opts in via frontmatter.
    const allChildTools = createAgentTools(childAgentId);
    const statusTool = allChildTools.find((t) => t.name === "check_agent_statuses")!;
    const delegateTool = tools?.includes("delegate_task")
      ? allChildTools.find((t) => t.name === "delegate_task")
      : undefined;

    const toolNames = [...(tools ?? ["read", "bash", "edit", "write"])];
    if (!toolNames.includes("check_agent_statuses")) {
      toolNames.push("check_agent_statuses");
    }

    const customTools = delegateTool ? [statusTool, delegateTool] : [statusTool];

    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: () => body,
    });
    await loader.reload();

    const sessionDir = path.join(os.tmpdir(), "spawned_agents", mainSessionId, childAgentId);
    await fs.mkdir(sessionDir, { recursive: true });

    const { session: sub } = await createAgentSession({
      tools: toolNames,
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.create(process.cwd(), sessionDir),
    });

    // Update the agent record with the session reference for abort support
    const agentRecord = manager.agents.get(childAgentId);
    if (agentRecord) {
      agentRecord.session = sub;
    }

    // ── Structured streaming via sub.subscribe() ──
    if (onUpdate) {
      /** Ordered log: {label, status}. Replaced in-place when tools finish. */
      const toolLog: ToolLogEntry[] = [];

      /**
       * Build a label from tool name + most descriptive arg.
       * Generic: picks the first short string argument — works for any tool.
       */
      const toolLabel = (name: string, args: Record<string, unknown> | undefined): string => {
        if (!args) return name;
        for (const v of Object.values(args)) {
          // Short string (path, command, query, pattern, url)
          if (typeof v === "string" && v.length > 0 && v.length < 200) {
            const preview = v.length > 40 ? v.slice(0, 40) + "…" : v;
            return `${name} ${preview}`;
          }
          // String array (queries, urls) — use first element
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
            const preview = v[0].length > 40 ? v[0].slice(0, 40) + "…" : v[0];
            return `${name} ${preview}`;
          }
        }
        return name;
      };

      const emit = () => onUpdate([...toolLog]);

      sub.subscribe((event: AgentSessionEvent) => {
        switch (event.type) {
          case "message_update": {
            if (event.assistantMessageEvent?.type === "text_delta") {
              emit();
            }
            break;
          }

          case "tool_execution_start": {
            const label = toolLabel(event.toolName, event.args);
            toolLog.push({ label, status: "running" });
            emit();
            break;
          }

          case "tool_execution_end": {
            const name = event.toolName;
            const ok = !event.isError;
            // Replace the last "running" entry for this tool name (robust pairing)
            for (let i = toolLog.length - 1; i >= 0; i--) {
              const entry = toolLog[i];
              if (entry && entry.label.startsWith(`${name} `) && entry.status === "running") {
                toolLog[i] = {
                  ...entry,
                  status: ok ? "done" : "error",
                };
                break;
              }
            }
            emit();
            break;
          }
        }
      });
    }

    await sub.prompt(task);
    result = extractResult(sub.agent.state);
    return result;
  } finally {
    manager.markDone(childAgentId, result);
  }
}
