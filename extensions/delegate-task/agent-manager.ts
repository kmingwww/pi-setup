import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Tracks child agents, enforces max depth (5), provides cleanup on exit. */

export interface AgentInfo {
  parentId: string | null;
  depth: number;
  status: 'running' | 'done';
  agentType: string;
  task: string;
  result?: string;
  session?: AgentSession;  // AgentSession reference; cleared on markDone()
}

export class AgentManager {
  public agents = new Map<string, AgentInfo>();

  constructor() {
    this.setupCleanupHooks();
  }

  register(id: string, parentId: string | null, agentType: string, task: string, session?: AgentSession): number {
    const parentDepth = parentId ? this.agents.get(parentId)?.depth || 0 : 0;
    const depth = parentDepth + 1;

    if (depth > 5) {
      throw new Error("Max agent depth (5) exceeded.");
    }

    this.agents.set(id, { parentId, depth, status: 'running', agentType, task, session });
    return depth;
  }

  markDone(id: string, result: string) {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = 'done';
      agent.result = result;
      agent.session = undefined;
    }
  }

  getActiveCount(): number {
    return Array.from(this.agents.values()).filter(a => a.status === 'running').length;
  }

  getAgentStatuses(currentAgentId: string): string {
    let context = "TEAM ACTIVITY:\n";
    for (const [id, agent] of this.agents.entries()) {
      const you = id === currentAgentId ? " \u2190 you" : "";
      context += `- [${agent.status.toUpperCase()}] ${agent.agentType} (${id})${you}\n  Task: ${agent.task}\n`;
    }
    return context;
  }

  async abortAll() {
    const promises = Array.from(this.agents.values())
      .filter((a): a is AgentInfo & { session: NonNullable<AgentInfo["session"]> } =>
        a.status === 'running' && a.session !== undefined && typeof a.session.abort === 'function')
      .map(a => a.session.abort().catch(() => {}));

    await Promise.all(promises);
  }

  private setupCleanupHooks() {
    const cleanup = () => {
      this.abortAll();
    };

    if (typeof process !== 'undefined') {
      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);
      process.on('exit', cleanup);
    }
  }
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
      // Continue to next path
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
          .map(s => s.trim().replace(/['"]/g, ''))
          .filter(s => s.length > 0);
      }
    }
  }
  return { body, tools };
}
export const agentManager = new AgentManager();
