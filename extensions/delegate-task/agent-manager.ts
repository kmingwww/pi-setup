import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AgentSession, SessionStats } from "@earendil-works/pi-coding-agent";

/** Tracks spawned agent sessions, provides cleanup on exit. */

export interface AgentInfo {
  status: "running" | "idle";
  agentType: string;
  currentTask?: string;
  result?: string;
  cwd?: string; // Working directory the agent operates in
  session?: AgentSession; // Kept alive after task completes for re-use
  notifications: string[]; // Async completion notifications from delegated tasks
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

export class AgentManager {
  public agents = new Map<string, AgentInfo>();

  /** Set by index.ts — wraps pi.sendUserMessage for async completion alerts. */
  public mainNotify?: (msg: string) => Promise<void>;

  constructor() {
    this.setupCleanupHooks();
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
      notifications: [],
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

      // Snapshot cost/token stats from the session if available
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

  /** Route a notification to an agent.
   *  If the target is a headless agent, stores on its record.
   *  If the target is known to mainNotify, delegates there.
   */
  async notifyAgent(targetId: string, msg: string): Promise<void> {
    if (targetId === "main") {
      await this.mainNotify?.(msg);
    } else {
      const agent = this.agents.get(targetId);
      if (agent) {
        agent.notifications.push(msg);
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

    // Also list available agent types that can be spawned
    const availableTypes = await discoverAgentTypes();
    if (availableTypes.length > 0) {
      context += `\n\nAVAILABLE TYPES (use as agentType in delegate_task):\n  ${availableTypes.join(", ")}`;
    }

    // Show pending notifications for the calling agent, then drain them
    if (currentAgentId) {
      const caller = currentAgentId === "main" ? null : this.agents.get(currentAgentId);
      const notifs = caller?.notifications;
      if (notifs && notifs.length > 0) {
        context += "\n\nPENDING RESULTS FROM DELEGATED TASKS:";
        for (const n of notifs) {
          context += `\n  • ${n}`;
        }
        notifs.length = 0; // drain
      }
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

    if (typeof process !== "undefined") {
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
      process.on("exit", cleanup);
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
