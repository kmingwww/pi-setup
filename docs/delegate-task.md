# delegate-task

Spawns background child agents from pi's main session. Each child runs in a headless `AgentSession` with an isolated context window, using a role-specific agent file (e.g. `~/.pi/agents/researcher.md`) for its system prompt and allowed tools.

## Flat architecture

All agents are **equal peers** — no parent-child hierarchy. Every agent has the same tools:

- `delegate_task` — delegate work to another agent
- `list_agents` — discover agents and check their status

### Persistence, not auto-reuse

After completing a task, an agent stays alive as **idle** in the pool. To reuse one, call `list_agents` first to see available agents and their IDs, then pass the desired `agentId` to `delegate_task`. Omit `agentId` to spawn a fresh agent.

This lets you have multiple researchers working on different topics without their contexts getting mixed.

## Tools

### `delegate_task`

| Parameter   | Type                | Description                                                                            |
| ----------- | ------------------- | -------------------------------------------------------------------------------------- |
| `agentType` | `string`            | Role name, maps to `{agentType}.md` in `.pi/agents/` or `~/.pi/agents/`                |
| `task`      | `string`            | Self-contained instructions                                                            |
| `mode`      | `"sync" \| "async"` | Sync blocks until done; async fires and forgets, notifies you when complete            |
| `agentId`   | `string?`           | Target an existing agent by ID (visible via `list_agents`). Omit to spawn a new agent. |
| `cwd`       | `string?`           | Working directory for the child agent. Tools resolve relative to this path.            |

### `list_agents`

Lists all agents with their status (`RUNNING` / `IDLE`), type, and current task. Returns agent IDs you can pass to `delegate_task` to reuse an existing agent.

If the calling agent has pending notifications from async delegated tasks, they are included in the output under `PENDING RESULTS FROM DELEGATED TASKS:` and then drained from the record. This prevents stale notifications from accumulating.

## Async notification

When an agent completes an async task, the notification goes to the **caller** — not always to main:

- **Caller is `main`** → `pi.sendUserMessage` for instant visibility
- **Caller is a headless agent** → stored on that agent's record, visible via `list_agents`

This keeps the main session's context clean — it only sees notifications for tasks it directly spawned.
Child agents see their own delegated task results without going through main.

## Architecture

```
agent-manager.ts          index.ts
(tracking, lifecycle)     (extension entry)
     │                          │
     │                          ├── agentManager.mainNotify → pi.sendUserMessage
     ▼                          │
run-worker.ts                  │
(facts only)                   │
     │                          │
     │  createChildSession()    │
     │  wireToolStream()        │
     │  extractResult()         │
     │                          │
     ├──────────► tools.ts ◄────┘
     │            (tool definitions)
     │  imports         │
     │  createAgentTools │  renderCall / renderResult
     │  (for child       │  theme.fg() colors, icons
     │   sessions)       │
     │                   ▼
     │            pi.registerTool()
     │
     ▼
AgentSession.subscribe()
(ToolLogEntry[] via onUpdate callback)
```

**`run-worker.ts`** — spawns or targets a child `AgentSession`, subscribes to events via `wireToolStream()`, emits structured `ToolLogEntry[]` through an `onUpdate` callback consumed by `tools.ts` for TUI rendering. Also imports `createAgentTools` from `tools.ts` to inject `delegate_task` and `list_agents` into child sessions, creating a mutual dependency.

**`tools.ts`** — defines the pi tools with `renderCall` and `renderResult` using `defineTool`. The `execute` callbacks call into `run-worker.ts`. Both tools are always available to all agents.

**`agent-manager.ts`** — tracks agents in a flat pool, stores async notifications per-agent, provides cleanup on SIGINT/SIGTERM. Sessions persist as `idle` after task completion.

**`index.ts`** — wires `agentManager.mainNotify` to `pi.sendUserMessage` for async completion alerts.

## Streaming

Uses `sub.subscribe()` via the `wireToolStream()` helper in `run-worker.ts`:

| Event                              | Action                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `message_update` with `text_delta` | Re-emit current tool log so the TUI updates                                                 |
| `tool_execution_start`             | Push `{label, status: "running"}` to tool log, emit update                                  |
| `tool_execution_end`               | Find last matching "running" entry for the tool, flip to `"done"` or `"error"`, emit update |

The tool label is derived from the tool name and its first string argument (truncated to 40 chars), so `web_search("pi agent docs")` renders as `web_search pi agent docs`.

## Display

### Streaming (partial result from `renderResult`)

When the agent is still running, the tool's `renderResult` shows:

```
[researcher] 3 tools
web_search pi agent docs        ✓
fetch_content github.com/pi     ○
read /home/user/config.ts       ○
```

When no tools have started yet, a fallback message is shown:

```
Starting…
```

### Render call (in the chat log, from `renderCall`)

Each `delegate_task` invocation appears in the conversation as:

```
delegate researcher [sync]
  Do research on the pi-agent SDK docs and return a summary…
```

Reusing an existing agent appends its ID:

```
delegate researcher [async] → agent-abc123
  Continue researching the authentication module…
```

### Final result (`renderResult` on completion)

```
✓ researcher done · 3 tools
  The latest pi documentation is available at...
```

### Error

```
✗ researcher done · 3 tools
  API rate limit exceeded while searching...
```

## Agent files

Discovered in order (relative to the child agent's working directory):

1. `.agent/agents/{type}.md` (legacy)
2. `.pi/agents/{type}.md` (project-local)
3. `~/.pi/agents/{type}.md` (global)

When the `cwd` parameter is provided, discovery starts from that directory instead of `process.cwd()`. This lets multiple projects define their own `.pi/agents/` with project-specific agent roles.

YAML frontmatter:

```yaml
---
tools: ["read", "bash", "edit", "write", "web_search", "fetch_content"]
---
```

The frontmatter `tools` list controls which built-in tools the agent can use. `delegate_task` and `list_agents` are **always** injected automatically (no need to list them).

Body after `---` becomes the system prompt.
