# notify

A pi extension that alerts you when the agent finishes a turn and is waiting for input. Useful when you switch away from the pi terminal and want to know it's ready.

- **Extension**: `extensions/notify.ts`
- **No LLM-facing tool** — hooks lifecycle events only

## How it works

The extension listens to the `agent_end` event (for normal turn completion), the `tool_call` event (when the agent uses `ask_user_question`), and a shared `user-input-needed` event on `pi.events` that any extension can emit. It fires notifications through every available backend.

**Event-driven design:** Other extensions (like `guardrail`) can trigger notifications by emitting `pi.events.emit("user-input-needed", { title, body })`. The notify extension listens on the shared event bus and fires a desktop notification when the terminal is unfocused. This keeps extensions decoupled — no imports needed between them.

Notifications only fire if **two conditions** are met:

1. **Interactive (TUI) mode** — subagents, RPC, print, and JSON modes are silently skipped.
2. **Terminal is unfocused** — it hooks into XTerm Focus Tracking (DECSET 1004) to monitor window focus. If you are actively looking at the terminal when the agent finishes, the notification is cleanly suppressed to prevent spam.

_(Note for `tmux` users: You must have `set -g focus-events on` in your `~/.tmux.conf` for focus tracking to pass through to pi)._

## Supported backends

| Backend           | OS                                     | Detection                             | Scope                                      | Sound                                   |
| ----------------- | -------------------------------------- | ------------------------------------- | ------------------------------------------ | --------------------------------------- |
| **macOS**         | macOS                                  | `which osascript`                     | Desktop popup (native Notification Center) | System default (`sound name "default"`) |
| **Linux**         | Linux                                  | `which notify-send`                   | Desktop popup (freedesktop)                | `sound-name:message` (daemon-dependent) |
| **Windows Toast** | Windows (WSL)                          | `WT_SESSION` + `which powershell.exe` | Desktop toast                              | System default (automatic)              |
| **OSC 99**        | Kitty                                  | `KITTY_WINDOW_ID`                     | Terminal notification                      | None (visual only)                      |
| **OSC 777**       | Ghostty, iTerm2, WezTerm, rxvt-unicode | Default fallback                      | Terminal notification                      | None (visual only)                      |

### Sound behavior by OS

| OS          | Mechanism                                                 | Default sound                                                                                                          |
| ----------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | `osascript display notification ... sound name "default"` | Plays the system notification sound (same as Messages, Mail, etc.)                                                     |
| **Windows** | PowerShell toast notification                             | Plays the system notification sound automatically                                                                      |
| **Linux**   | `notify-send --hint=string:sound-name:message`            | Depends on the notification daemon — GNOME Shell and Plasma play it; Dunst ignores it by default but can be configured |

On Linux, if you want guaranteed sound regardless of daemon, set up your notification daemon to respect `sound-name` hints or use a separate sound player alongside the notification.

## Backend selection priority

**Desktop** (mutually exclusive — only one fires):

```
osascript found?        →  macOS Notification Center
notify-send found?      →  Linux (freedesktop)
```

**Terminal** (mutually exclusive):

```
WT_SESSION + powershell?  →  Windows Toast
KITTY_WINDOW_ID?          →  OSC 99
otherwise                  →  OSC 777 (default)
```

Desktop and terminal backends fire **independently** — on macOS you'll get both a Notification Center popup and an OSC 777 terminal bell.

## Probe behavior

At extension load time (factory startup), the extension probes:

```
which osascript
which notify-send
which powershell.exe
```

Only backends whose binary is found are enabled. If you install a missing binary mid-session, run `/reload` to re-probe.

## Notification content

| Field | Value                                              |
| ----- | -------------------------------------------------- |
| Title | `Pi`                                               |
| Body  | `Done — "<user's prompt>"` (truncated to 72 chars) |

When no user prompt is found in the event messages, falls back to `Done — waiting for input`.

### Examples

| User prompt                                                                  | Notification body                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `fix the login bug`                                                          | `Done — "fix the login bug"`                                        |
| `refactor the auth module to use JWT`                                        | `Done — "refactor the auth module to use JWT"`                      |
| `this is a very long user prompt that exceeds the maximum truncation length` | `Done — "this is a very long user prompt that exceeds the maximu…"` |
| _(no user prompt — e.g. follow-up turn)_                                     | `Done — waiting for input`                                          |

## Startup message

On `session_start`, a one-line info notification shows which backends are active:

| Platform                      | Example output                                              |
| ----------------------------- | ----------------------------------------------------------- |
| macOS + Ghostty               | `Notify: desktop (macOS), OSC 777 (Background only)`        |
| Linux + notify-send + Ghostty | `Notify: desktop (Linux), OSC 777 (Background only)`        |
| Linux, no notify-send         | `Notify: OSC 777 (Background only)`                         |
| Kitty (any OS)                | `Notify: desktop (Linux), OSC 99 (Kitty) (Background only)` |
| WSL + Windows Terminal        | `Notify: Windows Toast (Background only)`                   |

## Non-interactive modes

The `agent_end` handler checks `ctx.mode !== "tui"` and returns early for:

- `print` mode (`pi -p`)
- `rpc` mode (`pi --mode rpc`)
- `json` mode

This prevents subagents, SDK integrations, and automated runs from spamming notifications.

## API for other extensions

Notify exposes a **single event contract** via `pi.events`. Any extension can trigger a
desktop notification by emitting `"user-input-needed"` — no imports, no coupling.

### Emitting a notification

```typescript
pi.events.emit("user-input-needed", {
  title: "Pi — My Extension",
  body: "Short description (≤72 chars recommended)",
});
```

### Contract

| Event name          | Payload                           | Behaviour                                                                                       |
| ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `user-input-needed` | `{ title: string, body: string }` | Fires a desktop notification **if** the terminal is unfocused and in TUI mode. No-op otherwise. |

Notify handles all the gates: TUI-mode check, focus tracking, probe completion,
and deduplication (`hasNotifiedThisWait`). Emitters don't need to worry about
any of that — just emit.

### Built-in emitters

| Emitter              | When                                                   |
| -------------------- | ------------------------------------------------------ |
| `input-bridge.ts`    | Agent calls `ask_user_question`                        |
| `guardrail/index.ts` | Dangerous command detected, showing Block/Allow prompt |

### Example: adding a custom emitter

```typescript
// your-extension.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Trigger a notification when your tool needs user attention
  pi.on("tool_call", async (event) => {
    if (event.toolName === "my_interactive_tool") {
      pi.events.emit("user-input-needed", {
        title: "Pi — My Tool",
        body: "Waiting for your input…",
      });
    }
  });
}
```

No import of notify needed. The event bus handles the rest.

## Installation

The extension is auto-discovered from `extensions/notify.ts` via the project's `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions/*"]
  }
}
```

To use it globally (all projects), copy to `~/.pi/agent/extensions/notify.ts` instead.
