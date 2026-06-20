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
import { AgentManager, findAgentFile, parseAgentFile, extractResultText } from "./agent-manager";
import { createAgentTools } from "./tools";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";

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
 *
 * @param replyTo Who the agent should report back to when re-invoked by
 *   an async sub-delegation result (sets agent.replyTo).
 */
export async function runWorker(
  task: string,
  agentType: string,
  mainSessionId: string,
  manager: AgentManager,
  agentId?: string,
  cwd?: string,
  onUpdate?: (entries: ToolLogEntry[]) => void,
  replyTo?: string,
): Promise<string> {
  // Target an existing agent by ID, if given and it exists
  if (agentId) {
    const existing = manager.agents.get(agentId);
    if (existing && existing.session) {
      if (replyTo) existing.replyTo = replyTo;
      manager.markRunning(agentId, task);

      if (onUpdate) {
        wireToolStream(existing.session, onUpdate);
      }

      try {
        await existing.session.prompt(task);
        const result = extractResultText(existing.session.agent.state);
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

  // Set replyTo on the new agent
  if (replyTo) {
    const record = manager.agents.get(childAgentId);
    if (record) record.replyTo = replyTo;
  }

  let result = "Task failed or was aborted.";
  try {
    const sub = await createChildSession(agentType, mainSessionId, childAgentId, cwd, onUpdate);

    const record = manager.agents.get(childAgentId);
    if (record) record.session = sub;

    await sub.prompt(task);
    result = extractResultText(sub.agent.state);
    return result;
  } finally {
    manager.markDone(childAgentId, result);
  }
}

/**
 * Fire-and-forget async wrapper around runWorker.
 *
 * On completion, delivers the result to the caller via manager.deliverMessage().
 * This uses session.sendUserMessage() for peer-to-peer delivery — idle agents
 * wake up and process the result automatically. No custom notification protocol.
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
        callerId, // replyTo — when this agent is re-invoked, report to the caller
      );
      await manager.deliverMessage(callerId, `✅ ${agentType} done: ${result}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await manager.deliverMessage(callerId, `❌ ${agentType} failed: ${message}`);
    }
  })();
}
