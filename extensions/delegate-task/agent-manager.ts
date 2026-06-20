import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AgentSession, SessionStats, AgentToolResult } from "@earendil-works/pi-coding-agent";

/** Delivery adapter for agents that don't have a directly accessible session (e.g. main). */
export interface AgentAdapter {
  /** Deliver a message to this agent. Called by peers when their async task finishes. */
  deliverMessage(content: string): Promise<void>;
}

/** Tracks spawned agent sessions, provides cleanup on exit. */
export interface AgentInfo {
  status: "running" | "idle";
  agentType: string;
  currentTask?: string;
  result?: string;
  cwd?: string;
  session?: AgentSession; // Kept alive after task completes for re-use
  /** Who to report back to when an async re-invoke finishes. */
  replyTo?: string;
  /** Cumulative token usage and cost from the agent session (snapshot at last markDone). */
  cost: number;
  tokenUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

type ContentBlock = AgentToolResult<unknown>["content"][number];

/** Extract the last assistant text block from agent state. */
export function extractResultText(state: Pick<AgentSession["agent"]["state"], "messages">): string {
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

export class AgentManager {
  public agents = new Map<string, AgentInfo>();

  /** Adapters for agents that don't have a session (e.g. main). */
  private adapters = new Map<string, AgentAdapter>();

  private _cleanup?: () => void;

  constructor() {
    this.setupCleanupHooks();
  }

  /**
   * Register an adapter for an agent that doesn't have a session directly
   * accessible to the manager (e.g. main). Adapters live outside the agents
   * map — they don't appear in list_agents or getActiveCount.
   */
  registerAdapter(id: string, adapter: AgentAdapter): void {
    this.adapters.set(id, adapter);
  }

  register(
    id: string,
    agentType: string,
    task: string,
    cwd?: string,
    session?: AgentSession,
  ): void {
    this.agents.set(id, {
      status: "running",
      agentType,
      currentTask: task,
      cwd,
      session,
      cost: 0,
      tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  }

  /** Assign a new task to an existing idle agent. */
  markRunning(id: string, task: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = "running";
      agent.currentTask = task;
    }
  }

  markDone(id: string, result: string): void {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = "idle";
      agent.result = result;
      agent.currentTask = undefined;
      // Session stays alive — NOT cleared

      if (agent.session) {
        try {
          const stats: SessionStats = agent.session.getSessionStats();
          agent.cost = stats.cost;
          agent.tokenUsage = { ...stats.tokens };
        } catch {
          // If getSessionStats fails, keep existing values
        }
      }
    }
  }

  /**
   * Peer-to-peer message delivery.
   *
   * If the target is RUNNING, queues the message as a follow-up via
   * session.sendUserMessage(). If IDLE, runs a new turn directly via
   * session.prompt() and forwards the result to the agent's replyTo.
   * If the target has no session, falls back to the adapter.
   */
  async deliverMessage(targetId: string, content: string): Promise<void> {
    const agent = this.agents.get(targetId);
    if (!agent) {
      const adapter = this.adapters.get(targetId);
      if (adapter) await adapter.deliverMessage(content);
      return;
    }

    if (!agent.session) return;

    if (agent.status === "running") {
      // Queue as follow-up — current turn will process it
      await agent.session.sendUserMessage(content, { deliverAs: "followUp" });
      return;
    }

    // IDLE — run a new turn and forward the result to replyTo
    const replyTo = agent.replyTo;
    agent.status = "running";
    agent.currentTask = content;

    try {
      await agent.session.prompt(content);
      const result = extractResultText(agent.session.agent.state);
      agent.status = "idle";
      agent.result = result;

      // Take a snapshot of token usage
      try {
        const stats: SessionStats = agent.session.getSessionStats();
        agent.cost = stats.cost;
        agent.tokenUsage = { ...stats.tokens };
      } catch {
        // keep existing values
      }

      // Forward the result up the chain
      if (replyTo) {
        await this.deliverMessage(replyTo, result);
      }
    } catch (error) {
      agent.status = "idle";
      agent.result = "failed";
      if (replyTo) {
        const msg = error instanceof Error ? error.message : String(error);
        await this.deliverMessage(replyTo, `❌ ${agent.agentType} failed: ${msg}`);
      }
    }
  }

  getActiveCount(): number {
    return Array.from(this.agents.values()).filter((a) => a.status === "running").length;
  }

  async getAgentStatuses(currentAgentId?: string): Promise<string> {
    let context = "RUNNING AGENTS:";
    for (const [id, agent] of this.agents.entries()) {
      const taskStr = agent.currentTask
        ? `\n  Task: ${agent.currentTask}`
        : agent.result
          ? `\n  Last: ${agent.result.slice(0, 120)}`
          : "";
      const cwdStr = agent.cwd && agent.cwd !== process.cwd() ? `\n  Cwd: ${agent.cwd}` : "";
      context += `\n- [${agent.status.toUpperCase()}] ${agent.agentType} (${id})${cwdStr}${taskStr}`;
    }

    const availableTypes = await discoverAgentTypes();
    if (availableTypes.length > 0) {
      context += `\n\nAVAILABLE TYPES (use as agentType in delegate_task):\n  ${availableTypes.join(", ")}`;
    }

    return context;
  }

  disposeAgent(id: string): void {
    const agent = this.agents.get(id);
    if (agent?.session) {
      agent.session.dispose();
    }
    this.agents.delete(id);
  }

  disposeAll(): void {
    for (const [id] of this.agents) {
      this.disposeAgent(id);
    }
  }

  async abortAll() {
    const promises = Array.from(this.agents.values())
      .filter(
        (a): a is AgentInfo & { session: NonNullable<AgentInfo["session"]> } =>
          a.status === "running" &&
          a.session !== undefined &&
          typeof a.session.abort === "function",
      )
      .map((a) => a.session.abort().catch(() => {}));

    await Promise.all(promises);
  }

  private setupCleanupHooks() {
    const cleanup = () => {
      this.abortAll();
    };
    this._cleanup = cleanup;

    if (typeof process !== "undefined") {
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("exit", cleanup);
    }
  }

  /** Remove process event listeners. Call in test cleanup or when discarding. */
  destroy(): void {
    if (this._cleanup && typeof process !== "undefined") {
      process.off("SIGINT", this._cleanup);
      process.off("SIGTERM", this._cleanup);
      process.off("exit", this._cleanup);
      this._cleanup = undefined;
    }
  }
}

/** Discover all available agent types by scanning known agent directories. */
export async function discoverAgentTypes(customCwd?: string): Promise<string[]> {
  const cwd = customCwd || process.cwd();
  const dirs = [
    path.join(cwd, ".pi", "agents"),
    path.join(cwd, ".agent", "agents"),
    path.join(os.homedir(), ".pi", "agents"),
  ];
  const types = new Set<string>();

  for (const dir of dirs) {
    try {
      const entries = await fs.readdir(dir);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          types.add(entry.slice(0, -3));
        }
      }
    } catch {
      // Directory doesn't exist or is inaccessible — skip
    }
  }

  return [...types].sort();
}

export async function findAgentFile(agentType: string, customCwd?: string): Promise<string | null> {
  const cwd = customCwd || process.cwd();
  const localLegacyPath = path.join(cwd, ".agent", "agents", `${agentType}.md`);
  const localPath = path.join(cwd, ".pi", "agents", `${agentType}.md`);
  const globalPath = path.join(os.homedir(), ".pi", "agents", `${agentType}.md`);

  const paths = [localLegacyPath, localPath, globalPath];

  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      // Continue
    }
  }

  return null;
}

export function parseAgentFile(content: string): { body: string; tools?: string[] } {
  let body = content;
  let tools: string[] | undefined = undefined;

  if (content.startsWith("---")) {
    const endMatch = content.indexOf("---", 3);
    if (endMatch !== -1) {
      const frontmatter = content.slice(3, endMatch);
      body = content.slice(endMatch + 3).trim();

      const toolsMatch = frontmatter.match(/tools:\s*\[(.*?)\]/);
      if (toolsMatch) {
        tools = (toolsMatch[1] ?? "")
          .split(",")
          .map((s) => s.trim().replace(/['"]/g, ""))
          .filter((s) => s.length > 0);
      }
    }
  }
  return { body, tools };
}

export const agentManager = new AgentManager();
