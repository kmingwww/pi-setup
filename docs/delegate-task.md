# delegate-task

Spawns background child agents from pi's main session. Each child runs in a headless `AgentSession` with an isolated context window, using a role-specific agent file (e.g. `~/.pi/agents/researcher.md`) for its system prompt and allowed tools.

## Tools

### `delegate_task`

| Parameter   | Type                | Description                                                                          |
| ----------- | ------------------- | ------------------------------------------------------------------------------------ |
| `agentType` | `string`            | Role name, maps to `{agentType}.md` in `.pi/agents/` or `~/.pi/agents/`              |
| `task`      | `string`            | Self-contained instructions — the child agent has **no memory** of your conversation |
| `mode`      | `"sync" \| "async"` | `"sync"` blocks until done; `"async"` not yet implemented                            |

Max delegation depth: 5 levels.

### `check_agent_statuses`

Lists all running and completed child agents with their tasks.

## Architecture

```
run-worker.ts          tools.ts
(facts only)           (presentation only)
     │                      │
     │  ToolLogEntry[]      │  renderCall / renderResult
     ├─────────────────────►│  theme.fg() colors, icons
     │                      │
     ▼                      ▼
AgentSession.subscribe()   pi.registerTool()
```

**`run-worker.ts`** — spawns the child `AgentSession`, subscribes to events, emits structured `ToolLogEntry[]`. No UI strings.

**`tools.ts`** — defines the pi tool with `renderCall` and `renderResult`, formats structured data with theme colors.

**`agent-manager.ts`** — tracks running agents, enforces max depth (5), provides cleanup on SIGINT/SIGTERM.

## Streaming

Uses `sub.subscribe()` (canonical `AgentSession` API, _not_ `sub.agent.subscribe()`):

| Event                           | Action                                                  |
| ------------------------------- | ------------------------------------------------------- |
| `message_update` + `text_delta` | Re-emit current status                                  |
| `tool_execution_start`          | Push `{label, status: "running"}` to tool log           |
| `tool_execution_end`            | Replace matching "running" entry with "done" or "error" |

Pi executes tools in parallel by default, so `tool_execution_start`/`tool_execution_end` can interleave. We match end events back to their running entries by scanning for the tool name prefix — no shared mutable state.

## Arg display

`toolLabel()` is fully generic (no per-tool switch/case):

- Iterates `Object.values(args)`
- Picks the first short string (< 200 chars) — covers `path`, `command`, `query`, `pattern`, `url`
- Falls back to first element of string arrays — covers `queries[]`, `urls[]`
- Truncates to 40 chars

## Display

### Streaming

```
[researcher] 3 tools
web_search "pi agent docs"       ✓
fetch_content github.com/pi      ○
read /home/user/config.ts        ○
```

### Final

```
✓ researcher done · 3 tools
  The latest pi documentation is available at...
```

## Agent files

Discovered in order:

1. `.agent/agents/{type}.md` (legacy)
2. `.pi/agents/{type}.md` (project-local)
3. `~/.pi/agents/{type}.md` (global)

YAML frontmatter:

```yaml
---
tools: ["read", "web_search", "fetch_content"]
---
```

Body after `---` becomes the system prompt.
