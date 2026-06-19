# Guardrail Extension Specification

## Overview

A **guardrail** is a safety gate that intercepts potentially harmful actions before
they execute. In pi-agent, this means subscribing to `tool_call` events and
returning `{ block: true }` when an action matches a denied pattern.

Protection is layered in two tiers:

1. **Non-negotiable:** `.git/` and `.pi/` — always blocked, no configuration.
2. **Optional:** `.agentignore` file — project-defined paths using gitignore syntax.

The extension has **two behavioural modes**, determined at runtime by whether a UI
is available:

| Mode                | `ctx.hasUI` | Behaviour                                    |
| ------------------- | ----------- | -------------------------------------------- |
| **Interactive**     | `true`      | Prompt the user with confirm/select dialogs. |
| **Non-interactive** | `false`     | Block by default (fail-safe). No prompts.    |

`ctx.hasUI` is `true` in TUI mode and RPC mode; `false` in print mode (`-p`) and
JSON mode.

## Guard Categories

### 1. Dangerous Bash Commands

Intercept `bash` tool calls and block commands matching dangerous patterns.

**Patterns (regex):**

| Pattern          | Matches                       |
| ---------------- | ----------------------------- | ----------------------------------- |
| `\brm\s+(-[rf]   | --recursive)`                 | `rm -rf`, `rm --recursive`, `rm -r` |
| `\bsudo\b`       | Any sudo invocation           |
| `\bchmod\b.*777` | `chmod … 777`                 |
| `\bchown\b`      | Any chown invocation          |
| `>\s*/dev/`      | Redirect to device files      |
| `\bmkfs\b`       | Filesystem formatting         |
| `\bdd\s+if=`     | `dd` disk imaging             |
| `:(){ :\|:& };:` | Fork bomb (literal substring) |

All patterns are case-insensitive (`/i` flag).

**Interactive mode:** Show `ctx.ui.select()` with the command and ask `Allow?`
→ `Yes` / `No`. If `No`, block with reason `"Blocked by user"`.

**Non-interactive mode:** Block with reason `"Dangerous command blocked (no UI)"`.

**Hook:** `pi.on("tool_call", …)` filtered to `event.toolName === "bash"`.

### 2. Protected File Paths

Intercept `write` and `edit` tool calls that target non-negotiable protected paths.

**Always-blocked paths (hardcoded, no configuration):**

| Path    | Rationale                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `.git/` | Corrupting the repo is never intentional. Universal across Claude Code, Codex, Cursor.                             |
| `.pi/`  | The agent's own config (`CONFIG_DIR_NAME`). Same reason Claude Code protects `.claude/`, Codex protects `.codex/`. |

That's it — two entries. No `.env`, no `node_modules/`, no lockfiles. Those are
project conventions, not universal safety hazards.

**All modes, always:** Notify with `ctx.ui.notify("Blocked write to protected path: …", "warning")`
and return `{ block: true, reason: "Path is protected" }`. No prompts — these two paths
are non-negotiable.

#### `.agentignore` (optional, additional protection)

If a `.agentignore` file exists in the project root, it is read and its patterns are
treated as additional protected paths. The format mirrors `.gitignore`: one glob
pattern per line, `#` for comments, blank lines ignored. The file is discovered by
walking up from `ctx.cwd` to the git root (or filesystem root if not in a repo).

Example `.agentignore`:

```
# Never let the agent touch these
.env
.env.*
!*.env.example
node_modules/
*.pem
*.key
secrets/
```

- `.agentignore` is **purely additive** — it cannot undo the two hardcoded paths.
- It is **optional** — no file means no extra protection beyond `.git/` and `.pi/`.
- Pattern matching uses the same semantics as `.gitignore` (leading `/` anchors to
  the file's directory, `**` for arbitrary depth, trailing `/` matches directories).
- `!` negation patterns are supported for allowlisting sub-paths.

**Hook:** `pi.on("tool_call", …)` filtered to `event.toolName === "write" || event.toolName === "edit"`.

## Architecture

### File Layout

Single-file extension at `~/.pi/agent/extensions/guardrail.ts`:

```
~/.pi/agent/extensions/
└── guardrail.ts
```

### API Imports

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
```

No external npm dependencies. Uses only the pi-agent SDK and Node.js built-ins.

### Extension Structure

```typescript
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", handleBashGuardrail);
  pi.on("tool_call", handlePathGuardrail);
}
```

Each handler is a standalone function, testable in isolation.

### Handler Signatures

```typescript
// Bash guardrail
async function handleBashGuardrail(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined>;

// Path guardrail
async function handlePathGuardrail(
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<{ block: true; reason: string } | undefined>;
```

---

## Behaviour Decision Table

| Scenario                                  | Interactive       | Non-interactive   |
| ----------------------------------------- | ----------------- | ----------------- |
| Bash matches dangerous pattern            | Prompt `select()` | Block (no prompt) |
| Write/edit targets `.git/` or `.pi/`      | Block (no prompt) | Block (no prompt) |
| Write/edit matches `.agentignore` pattern | Block (no prompt) | Block (no prompt) |

## Error Handling

- If `ctx.ui.*` throws (e.g. UI subsystem unavailable), fall back to blocking.
- Catch-all in each handler so a guardrail crash never causes the agent to hang.
- Log errors via `console.error()` (visible in TUI with `--debug`).

---

## References

- [pi-agent Extensions Documentation](https://…/docs/extensions.md)
  - `pi.on("tool_call", …)` → block tool execution
  - `ctx.hasUI`, `ctx.mode` → detect interactive vs non-interactive
  - `ctx.ui.confirm()`, `ctx.ui.select()`, `ctx.ui.notify()` → user interaction
  - `pi.events` → inter-extension event bus (see `docs/notify.md` for the `user-input-needed` contract)
- This project's extensions:
  - `notify.ts` — desktop notification listener driven by `pi.events` (see `docs/notify.md`)
  - `input-bridge.ts` — bridges `ask_user_question` tool calls to `user-input-needed` events
  - `guardrail/` — emits `user-input-needed` before showing Block/Allow prompts
- Example extensions:
  - `permission-gate.ts` — dangerous bash command confirmation
  - `protected-paths.ts` — path-based write/edit blocking
