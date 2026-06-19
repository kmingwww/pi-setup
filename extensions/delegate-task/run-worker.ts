/** Spawns / targets a child AgentSession. Emits structured ToolLogEntry[] via onUpdate. */

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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Structured tool activity — facts only. Presentation lives in tools.ts renderResult. */
export interface ToolLogEntry {
  label: string;
  status: "running" | "done" | "error";
}

/**
 * Subscribe to a session's event stream and route structured tool-log entries
 * to onUpdate. Starts with a fresh empty toolLog so stale entries from
 * previous runs are not carried over.
 */
function wireToolStream(session: AgentSession, onUpdate: (entries: ToolLogEntry[]) => void): void {
  const toolLog: ToolLogEntry[] = [];

  const toolLabel = (name: string, args: Record<string, unknown> | undefined): string => {
    if (!args) return name;
    for (const v of Object.values(args)) {
      if (typeof v === "string" && v.length > 0 && v.length < 200) {
        const preview = v.length > 40 ? v.slice(0, 40) + "…" : v;
        return `${name} ${preview}`;
      }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") {
        const preview = v[0].length > 40 ? v[0].slice(0, 40) + "…" : v[0];
        return `${name} ${preview}`;
      }
    }
    return name;
  };

  const emit = () => onUpdate([...toolLog]);

  session.subscribe((event: AgentSessionEvent) => {
    switch (event.type) {
      case "message_update": {
        if (event.assistantMessageEvent?.type === "text_delta") emit();
        break;
      }
      case "tool_execution_start": {
        toolLog.push({ label: toolLabel(event.toolName, event.args), status: "running" });
        emit();
        break;
      }
      case "tool_execution_end": {
        const ok = !event.isError;
        for (let i = toolLog.length - 1; i >= 0; i--) {
          const entry = toolLog[i];
          if (entry && entry.label.startsWith(`${event.toolName} `) && entry.status === "running") {
            toolLog[i] = { ...entry, status: ok ? "done" : "error" };
            break;
          }
        }
        emit();
        break;
      }
    }
  });
}

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
    if (typeof content === "string") {
      const text = content.trim();
      if (text) return text;
      continue;
    }
    if (content.length === 0) continue;
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

async function createChildSession(
  agentType: string,
  mainSessionId: string,
  childAgentId: string,
  cwd?: string,
  onUpdate?: (entries: ToolLogEntry[]) => void,
): Promise<AgentSession> {
  const agentCwd = cwd ?? process.cwd();
  const contextPath = await findAgentFile(agentType, agentCwd);

  let rawContent = "You are a helpful background agent.";
  if (contextPath) {
    try {
      rawContent = await fs.readFile(contextPath, "utf-8");
    } catch {
      // Falls back to default
    }
  }

  const { body, tools } = parseAgentFile(rawContent);

  // Both tools always available to every agent
  const allChildTools = createAgentTools(childAgentId);
  const statusTool = allChildTools.find((t) => t.name === "list_agents")!;
  const delegateTool = allChildTools.find((t) => t.name === "delegate_task")!;
  const customTools = [statusTool, delegateTool];

  const toolNames = [...(tools ?? ["read", "bash", "edit", "write"])];
  if (!toolNames.includes("list_agents")) toolNames.push("list_agents");
  if (!toolNames.includes("delegate_task")) toolNames.push("delegate_task");

  const loader = new DefaultResourceLoader({
    cwd: agentCwd,
    agentDir: getAgentDir(),
    systemPromptOverride: () => body,
  });
  await loader.reload();

  const sessionDir = path.join(os.tmpdir(), "spawned_agents", mainSessionId, childAgentId);
  await fs.mkdir(sessionDir, { recursive: true });

  const { session: sub } = await createAgentSession({
    cwd: agentCwd,
    tools: toolNames,
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.create(agentCwd, sessionDir),
  });

  // ── Structured streaming via sub.subscribe() ──
  if (onUpdate) {
    wireToolStream(sub, onUpdate);
  }

  return sub;
}

/**
 * Run a task on a child agent.
 *
 * When targeting an existing agent by ID the agent keeps its accumulated context.
 * When no ID is given, or the target agent doesn't exist, a new agent is created.
 * After completion the agent stays alive (idle) for future reuse.
 */
export async function runWorker(
  task: string,
  agentType: string,
  mainSessionId: string,
  manager: AgentManager,
  agentId?: string,
  cwd?: string,
  onUpdate?: (entries: ToolLogEntry[]) => void,
): Promise<string> {
  // Target an existing agent by ID, if given and it exists
  if (agentId) {
    const existing = manager.agents.get(agentId);
    if (existing && existing.session) {
      manager.markRunning(agentId, task);

      // ── Wire onUpdate to the existing session's event stream ──
      if (onUpdate) {
        wireToolStream(existing.session, onUpdate);
      }

      try {
        await existing.session.prompt(task);
        const result = extractResult(existing.session.agent.state);
        manager.markDone(agentId, result);
        return result;
      } catch (error) {
        manager.markDone(agentId, "failed");
        throw error;
      }
    }
  }

  // No target ID given (or target doesn't exist) — create a new agent
  const childAgentId = `agent-${crypto.randomUUID()}`;
  manager.register(childAgentId, agentType, task, cwd);

  let result = "Task failed or was aborted.";
  try {
    const sub = await createChildSession(agentType, mainSessionId, childAgentId, cwd, onUpdate);

    const record = manager.agents.get(childAgentId);
    if (record) record.session = sub;

    await sub.prompt(task);
    result = extractResult(sub.agent.state);
    return result;
  } finally {
    manager.markDone(childAgentId, result);
  }
}

/**
 * Fire-and-forget async wrapper around runWorker.
 * On completion, routes the notification to the caller via manager.notifyAgent.
 * - Caller is "main" → pi.sendUserMessage (via mainNotify)
 * - Caller is a headless agent → stored on that agent's record (visible via list_agents)
 * Never throws.
 */
export function runWorkerAsync(
  task: string,
  agentType: string,
  mainSessionId: string,
  manager: AgentManager,
  callerId: string,
  agentId?: string,
  cwd?: string,
  onUpdate?: (entries: ToolLogEntry[]) => void,
): void {
  void (async () => {
    try {
      const result = await runWorker(
        task,
        agentType,
        mainSessionId,
        manager,
        agentId,
        cwd,
        onUpdate,
      );
      await manager.notifyAgent(callerId, `✅ ${agentType} done: ${truncate(result, 280)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await manager.notifyAgent(callerId, `❌ ${agentType} failed: ${truncate(message, 280)}`);
    }
  })();
}
