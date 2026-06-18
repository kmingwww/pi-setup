# Agent Implementation Specification

## Overview

This specification details how to implement asynchronous background workers (agents) using the Pi Agent SDK. The goal is to allow a primary agent to spawn secondary agent instances for long-running or parallel tasks, and receive a notification when those tasks complete, without blocking the primary agent's workflow.

## Architecture

The implementation relies on three core SDK concepts:

1. **Custom Tools (`defineTool`)**: To expose the spawning capability to the main agent, allowing it to choose between synchronous (blocking) and asynchronous (background) execution.
2. **Session Isolation (`createAgentSession`)**: To instantiate an independent memory and execution context for the child agent.
3. **Queueing (`session.followUp` / `session.steer`)**: To safely inject the completion notification back into the main agent's context when running in asynchronous mode.

In addition to the SDK basics, an **Agent Manager** handles the hierarchical structure, lifecycle, and safety boundaries (such as concurrency and maximum spawn depth) for all active agents.

### 1. Agent Manager & Hierarchy

To prevent runaway recursion and track resource usage, all agents (including the root) must be tracked via a centralized manager.

- **Tree Structure:** The manager maintains a tree mapping each agent to its parent (if any) and tracking its depth.
- **Depth Limiting:** The manager enforces a strict maximum depth limit of 5. If an agent at depth 5 attempts to spawn a child agent, the tool immediately rejects the request and returns an error message.
- **Registry:** The manager maintains a registry of active, pending, and completed agents, allowing for status queries (e.g., "how many agents are currently running?").
- **Process Lifecycle Management:** The manager hooks into process exit signals (`SIGINT`, `SIGTERM`, `uncaughtException`) to gracefully abort any active child agent sessions before the main process exits.

### 2. Spawner Tool (Main Agent)

A custom tool must be registered on the main agent.

- **Trigger:** The main agent decides to delegate a task.
- **Parameters:** The tool accepts the `task` instruction and an execution `mode` (e.g., `sync` or `async`).
- **Execution (Sync):** The tool `await`s the child agent's completion and returns the final output directly as the tool's result. The main agent pauses its execution until the child agent finishes.
- **Execution (Async):** The tool initiates the child agent asynchronously (fire-and-forget) and returns an immediate string response to the main agent acknowledging that the background process has started.

### 3. Agent Types & Context

Instead of spawning generic clones, the system supports specialized agents (e.g., "researcher", "reviewer", "coder").

- **Agent Definitions:** The definitions for these specialized agents are stored in markdown files.
- **Context Loading:** These files contain the agent's context, instructions, and role descriptions.
- **Tool Restrictions (Frontmatter):** Agent files can use YAML frontmatter to explicitly define a whitelist of allowed tools. For example, a researcher might only be given the `read` and `web_search` tools, ensuring it cannot accidentally edit files.
- **Non-Interactive Execution:** All spawned child agents must run in a strictly non-interactive mode. Tools that wait for human input (like `ask_user_question` or interactive prompt tools) must be explicitly excluded or unavailable, as background agents run entirely headless.
- **Initialization:** When delegating a task to a new agent, the `delegate_task` tool requires an `agentType` parameter. The runner uses its internal helper to resolve the file (checking local `.agent/agents/`, local `.pi/agents/`, and global `~/.pi/agents/`), extracts the tool whitelist from the frontmatter, and injects the markdown body into the new session via `systemPromptOverride`.

### 4. Agent Execution Lifecycle

The asynchronous runner function handles the isolated child agent:

- **Initialization:** Reads the agent context from `.pi/agents/${agentType}.md` (or `.agent/agents/` / `~/.pi/agents/`). Calls `createAgentSession()` to spin up a new agent.
- **Persistence (Logging):** Child agent session histories (the raw JSONL message logs) are automatically saved to a temporary directory using `SessionManager.create(tempDir)`. This ensures they can be inspected by developers for debugging without cluttering the main project's git repository. The path format is `[OS_TMP]/spawned_agents/[main_session_id]/[child_agent_id]`.
- **Tracking:** Registers the new session with the **Agent Manager**, assigning it a unique ID, its parent's ID, its calculated depth, and a reference to the `AgentSession` instance.
- **Configuration:** The child agent is configured with the loaded context (`systemPromptOverride`). It is also injected with the spawner tool so it can recursively spawn its own children (if depth allows).
- **Execution:** Calls `subSession.prompt(task)` and awaits completion.
- **Extraction & Cleanup:** Upon completion, extracts the final response from `subSession.agent.state.messages` and marks the session as finished/terminated in the manager, dropping the session reference.

### 5. Swarm Communication & State Sharing

By default, child agents run in isolated sessions and cannot see the state or progress of their peers. To give agents the "big picture" of what the team is doing without introducing race conditions, the manager maintains a lightweight, read-only in-memory context.

- **The Big Picture Tools:** Agents are equipped with specific tools to interact with the swarm. `check_team_status` queries the `AgentManager` and returns a stringified summary of all active and recently completed agents, their roles, and their assigned tasks.
- **Dependency Resolution (Awaiting Results):** Instead of an active agent polling or explicitly calling a "get result" tool-which blocks the LLM context thread and wastes time-agents coordinate via **Task Delegation callbacks**. If Agent A needs the result of Agent B, Agent A delegates the task to Agent B via `delegate_task` (using `mode: "sync"` to block, or `mode: "async"` to let the system queue the result via `session.followUp()`).
- **Ping-Back Updates:** When an asynchronous child agent finishes, its result is automatically injected back into the spawner's queue via `session.followUp()`. The orchestrator (parent agent) processes the newly arrived result and decides the next step, rather than actively checking for completion.
- **Interactive Mode Only (TUI):** To avoid cluttering the interactive UI for human users, tools like `check_team_status` can be restricted so they are only passed to the programmatic background sessions, and not exposed globally to the main TUI.
- **Agent Retention:** The `AgentManager` retains records of all spawned agents even after they finish. While the actual `AgentSession` is destroyed to free memory, the manager keeps the agent's ID, type, task, and status. This allows `check_team_status` to show a historical audit of what the team has accomplished.
- **Avoiding File Races:** Because the "big picture" is generated dynamically from the `AgentManager`'s in-memory registry, agents cannot create race conditions. They query the manager, rather than editing a shared file.

### 6. Callback / Ping-Back (Async Mode Only)

- The async runner formats a system notification string containing the original task and the child agent's output.
- It calls `mainSession.followUp(notificationText)`.
- `followUp` guarantees thread safety: if the main agent is idle, it processes the notification immediately. If it is currently streaming a response or executing another tool, the notification is queued and processed as soon as the current turn ends.

## API Example Surface (Conceptual)

```typescript
// The Manager
import { AgentSession } from "@earendil-works/pi-coding-agent";

class AgentManager {
  private agents = new Map<
    string,
    {
      parentId: string | null;
      depth: number;
      status: "running" | "done";
      agentType: string;
      task: string;
      result?: string;
      session?: AgentSession;
    }
  >();

  constructor() {
    this.setupCleanupHooks();
  }

  register(
    id: string,
    parentId: string | null,
    agentType: string,
    task: string,
    session: AgentSession,
  ) {
    const parentDepth = parentId ? this.agents.get(parentId)?.depth || 0 : 0;
    const depth = parentDepth + 1;

    if (depth > 5) throw new Error("Max agent depth (5) exceeded.");

    this.agents.set(id, { parentId, depth, status: "running", agentType, task, session });
    return depth;
  }

  markDone(id: string, result: string) {
    const agent = this.agents.get(id);
    if (agent) {
      agent.status = "done";
      agent.result = result;
      agent.session = undefined; // Free memory but keep the record
    }
  }

  getActiveCount() {
    return Array.from(this.agents.values()).filter((a) => a.status === "running").length;
  }

  getTeamStatus() {
    let context = "TEAM ACTIVITY:\n";
    for (const [id, agent] of this.agents.entries()) {
      context += `- [${agent.status.toUpperCase()}] ${agent.agentType} (${id})\n  Task: ${agent.task}\n`;
    }
    return context;
  }

  // Gracefully abort all running agents
  async abortAll() {
    const promises = Array.from(this.agents.values())
      .filter((a) => a.status === "running" && a.session)
      .map((a) => a.session!.abort().catch(() => {}));

    await Promise.all(promises);
  }

  private setupCleanupHooks() {
    const cleanup = () => {
      // Abort in a non-blocking manner on exit
      this.abortAll();
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", cleanup);
  }
}

const manager = new AgentManager();

// Factory to create the team management tools for a specific agent
function createAgentTools(currentAgentId: string) {
  const delegateTool = defineTool({
    name: "delegate_task",
    description:
      "Delegate a sub-task to a specialized background agent. Use 'sync' to pause your own work and wait for the result. Use 'async' to fire-and-forget, allowing you to do other things until you are notified of completion.",
    parameters: Type.Object({
      agentType: Type.String({
        description: "The role of the agent to delegate to (e.g., 'researcher', 'coder').",
      }),
      task: Type.String({
        description:
          "Detailed, self-contained instructions. The background agent has no memory of your current conversation, so you MUST include all necessary context, file paths, and specific goals.",
      }),
      mode: Type.Union([Type.Literal("sync"), Type.Literal("async")]),
    }),
    execute: async (id, params) => {
      // Validate depth early
      const parentDepth = manager.agents.get(currentAgentId)?.depth || 0;
      if (parentDepth >= 5) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Maximum delegation depth of 5 reached. Cannot delegate further.",
            },
          ],
        };
      }

      if (params.mode === "sync") {
        const result = await runWorker(params.task, params.agentType, currentAgentId);
        return { content: [{ type: "text", text: result }] };
      } else {
        runWorkerAsync(params.task, params.agentType, currentAgentId);
        return {
          content: [
            {
              type: "text",
              text: `Background task delegated to ${params.agentType}. You will be notified via followUp.`,
            },
          ],
        };
      }
    },
  });

  const statusTool = defineTool({
    name: "check_team_status",
    description:
      "Check the status of all delegated background agents. Use this to see what the team is currently doing to avoid duplicating tasks.",
    parameters: Type.Object({}),
    execute: async () => {
      return { content: [{ type: "text", text: manager.getTeamStatus() }] };
    },
  });

  return [delegateTool, statusTool];
}

// Run worker
import fs from "fs/promises";
import path from "path";
import os from "os";
import { DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

// Helper to find the agent definition file
async function findAgentFile(agentType: string): Promise<string | null> {
  const localLegacyPath = path.join(process.cwd(), ".agent", "agents", `${agentType}.md`);
  const localPath = path.join(process.cwd(), ".pi", "agents", `${agentType}.md`);
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

// Helper to parse basic frontmatter
function parseAgentFile(content: string) {
  let body = content;
  let tools: string[] | undefined = undefined;

  if (content.startsWith("---")) {
    const endMatch = content.indexOf("---", 3);
    if (endMatch !== -1) {
      const frontmatter = content.slice(3, endMatch);
      // The body is everything after the second '---' delimiter
      body = content.slice(endMatch + 3).trim();

      // Basic regex parsing for the spec example
      const toolsMatch = frontmatter.match(/tools:\s*\[(.*?)\]/);
      if (toolsMatch) {
        tools = toolsMatch[1].split(",").map((s) => s.trim().replace(/['"]/g, ""));
      }
    }
  }
  return { body, tools };
}

async function runWorker(task: string, agentType: string, parentId: string) {
  const childAgentId = `agent-${Date.now()}`;

  // Resolve context file prioritizing local over global
  const contextPath = await findAgentFile(agentType);

  let rawContent = "You are a helpful background agent.";
  if (contextPath) {
    try {
      rawContent = await fs.readFile(contextPath, "utf-8");
    } catch (err) {
      console.warn(`Failed to read agent file at ${contextPath}. Using default.`);
    }
  } else {
    console.warn(
      `Agent context file not found for type: ${agentType}. Checked local and global. Using default.`,
    );
  }

  const { body, tools } = parseAgentFile(rawContent);

  const loader = new DefaultResourceLoader({
    systemPromptOverride: () => body,
  });
  await loader.reload();

  // Create persistence directory for this specific child agent
  // mainSession.sessionId must be available in scope
  const sessionDir = path.join(os.tmpdir(), "spawned_agents", mainSession.sessionId, childAgentId);
  await fs.mkdir(sessionDir, { recursive: true });

  const { session: sub } = await createAgentSession({
    tools, // Undefined means default built-ins are used. If set, ONLY these tools are available.
    customTools: createAgentTools(childAgentId), // Pass the tools down so it can recurse and read context
    resourceLoader: loader,
    sessionManager: SessionManager.create(sessionDir), // Persist to OS temp directory
  });

  manager.register(childAgentId, parentId, agentType, task, sub);

  let result = "Task failed or was aborted.";
  try {
    await sub.prompt(task);
    result = extractResult(sub.agent.state);
    return result;
  } finally {
    manager.markDone(childAgentId, result);
  }
}

// Async wrapper that pings back the main agent
async function runWorkerAsync(task: string, agentType: string, parentId: string) {
  const result = await runWorker(task, agentType, parentId);
  await mainSession.followUp(
    `[SYSTEM]: Background agent (${agentType}) completed task. Result: ${result}`,
  );
}
```

## Considerations

- **Concurrency Limits:** Care should be taken to limit how many agents can be spawned concurrently to avoid rate-limiting from the AI provider.
- **Error Handling:** The async worker must catch errors (e.g., network failures, LLM context limits) and send a `followUp` notifying the main agent of the failure, rather than crashing the Node process.
- **State Sharing:** Child agents have zero context of the main agent's conversation by default. If context is needed, the spawner agent must pass it explicitly via the tool parameters.
