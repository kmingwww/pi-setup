# Agent SDK Implementation Plan

This document breaks down the implementation of the Swarm Agent feature (as specified in `docs/spec/agent-spec.md`) into logical, manageable phases. This approach allows for incremental testing and integration with the Pi Agent SDK.

## Phase 1: Core Agent Manager & Context Loader
**Goal:** Build the foundational state management and file parsing utilities. This phase does not interact with the Pi SDK or LLMs at all; it is purely data structures and file I/O.

1. **Create the `AgentManager` class:**
   - Implement the internal `Map` to store agent metadata (id, parentId, depth, status, agentType, task). *(Leave the `session` property as `any` or omit it for now).*
   - Implement `register(id, parentId, agentType, task)` with strict depth-limit checking (max depth 5).
   - Implement `markDone(id, result)`.
   - Implement `getTeamStatus()` to format the registry into a readable string.
2. **Implement Agent Context Discovery:**
   - Write `findAgentFile(agentType)` to check `[cwd]/.agent/agents/`, `[cwd]/.pi/agents/`, and `~/.pi/agents/` in order.
   - Write `parseAgentFile(content)` to extract YAML frontmatter (`tools` array) and return the stripped markdown body.

*Deliverable:* A standalone TypeScript module with unit tests proving that the Manager correctly tracks hierarchical depth, and the parser correctly extracts tools and body text from a dummy markdown file.

## Phase 2: Synchronous Orchestration (`runWorker`)
**Goal:** Integrate Phase 1 with the Pi Agent SDK to spawn a child agent that runs synchronously. 

1. **Implement `runWorker(task, agentType, parentId)`:**
   - Integrate `findAgentFile` and `parseAgentFile` to get the context and allowed tools.
   - Setup a `DefaultResourceLoader` using `systemPromptOverride` to inject the parsed body.
   - Setup the OS temp directory path for persistence: `path.join(os.tmpdir(), "spawned_agents", "manual-test", childAgentId)`.
   - Instantiate `createAgentSession()` passing the `tools`, `resourceLoader`, and `SessionManager.create()`.
   - Register the session with the `AgentManager`.
   - Await `sub.prompt(task)` and return the extracted string result.
   - Call `markDone()` in a `finally` block.
2. **Implement Process Hooks (in `AgentManager`):**
   - Now that we have real `AgentSession` objects, update the Manager to store the session reference.
   - Implement `abortAll()` to iterate over running sessions and call `session.abort()`.
   - Bind hooks to `SIGINT`, `SIGTERM`, and `exit`.

*Deliverable:* A script that can be run from the CLI (e.g., `ts-node test-sync.ts`) that programmatically spawns a child agent to perform a specific task, waits for it to finish, prints the result, and correctly saves the JSONL log to `/tmp/`.

## Phase 3: AI Tool Integration (`delegate_task` & `check_team_status`)
**Goal:** Expose the orchestration logic to an AI so a main agent can trigger the child agent itself, but keeping it **synchronous only** for now to ensure tool stability.

1. **Implement `createAgentTools(currentAgentId)`:**
   - Define the `delegate_task` tool using `defineTool`. For this phase, only implement the `sync` logic.
   - Define the `check_team_status` tool to return `manager.getTeamStatus()`.
2. **Tool Injection:**
   - Write a setup script that starts an interactive Pi session (or a `runPrintMode` session) and injects these tools via `customTools`.

*Deliverable:* You can open a chat with the main agent and say, "Delegate a task to a researcher to find X." The agent successfully uses the tool, the TUI pauses while the child agent runs in the background, and the tool returns the final answer to the main agent.

## Phase 4: Asynchronous Execution & Ping-Backs
**Goal:** Enable true background parallel processing by implementing the asynchronous fire-and-forget mode.

1. **Implement `runWorkerAsync`:**
   - Wrap `runWorker` in a non-blocking function.
   - Add the ping-back logic: upon completion, format the result and use `mainSession.followUp()` to push the result back to the parent agent. *(Note: This requires passing the `mainSession` reference down or making it accessible to the worker).*
2. **Update `delegate_task`:**
   - Implement the `async` branch in the tool execution logic. 
   - Ensure the tool immediately returns "Background task started..." to the main agent.
3. **Error Boundaries:**
   - Add robust try/catch blocks around the worker execution so that if a background agent crashes, a `followUp` is still sent with the error message, rather than silently failing or crashing the Node process.

*Deliverable:* You can ask the main agent to "Delegate a task async, then tell me a joke while we wait." The agent delegates the task, immediately tells you a joke, and 30 seconds later, the background result pops into the chat via a system notification.

## Phase 5: Workflow Orchestration & Documentation
**Goal:** While the optimized tool schemas (Phase 3) provide enough instruction for the AI to understand *how* to use the tools, we need to document *when* and *why* to use them for specific workflows.

1. **Rely on Schema Proximity:** 
   - Ensure the tool descriptions natively handle the "golden rules" (e.g., reminding the AI that child agents have no memory, and enforcing the check of `team_status` before fetching results). This guarantees the tools work out-of-the-box without requiring users to write massive prompts.
2. **Provide Orchestration Examples (`AGENTS.md`):**
   - Provide an optional `AGENTS.md` template for users. This file should focus on *Workflow Strategy* rather than tool mechanics.
   - Example Rule: *"When asked to build a new full-stack feature, ALWAYS spawn an async `researcher` agent to read the API docs, while you synchronously scaffold the UI."*
3. **Create Agent Profiles (`.pi/agents/`):**
   - Create specialized templates (e.g., `researcher.md`, `coder.md`) defining their tools and roles to demonstrate the feature's capability.

*Deliverable:* The feature works cleanly out-of-the-box driven purely by schema definitions. A set of markdown templates is provided to users demonstrating how to define team workflows via `AGENTS.md`.