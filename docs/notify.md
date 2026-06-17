# notify

A pi extension that alerts you when the agent finishes a turn and is waiting for input. Useful when you switch away from the pi terminal and want to know it's ready.

- **Extension**: `extensions/notify.ts`
- **No LLM-facing tool** — hooks lifecycle events only

## How it works

The extension listens to the `agent_end` event and fires notifications through every available backend. 

Notifications only fire if **two conditions** are met:
1. **Interactive (TUI) mode** — subagents, RPC, print, and JSON modes are silently skipped.
2. **Terminal is unfocused** — it hooks into XTerm Focus Tracking (DECSET 1004) to monitor window focus. If you are actively looking at the terminal when the agent finishes, the notification is cleanly suppressed to prevent spam.

*(Note for `tmux` users: You must have `set -g focus-events on` in your `~/.tmux.conf` for focus tracking to pass through to pi).*

## Supported backends

| Backend | OS | Detection | Scope | Sound |
|---------|----|-----------|-------|-------|
| **macOS** | macOS | `which osascript` | Desktop popup (native Notification Center) | System default (`sound name "default"`) |
| **Linux** | Linux | `which notify-send` | Desktop popup (freedesktop) | `sound-name:message` (daemon-dependent) |
| **Windows Toast** | Windows (WSL) | `WT_SESSION` + `which powershell.exe` | Desktop toast | System default (automatic) |
| **OSC 99** | Kitty | `KITTY_WINDOW_ID` | Terminal notification | None (visual only) |
| **OSC 777** | Ghostty, iTerm2, WezTerm, rxvt-unicode | Default fallback | Terminal notification | None (visual only) |

### Sound behavior by OS

| OS | Mechanism | Default sound |
|----|-----------|---------------|
| **macOS** | `osascript display notification ... sound name "default"` | Plays the system notification sound (same as Messages, Mail, etc.) |
| **Windows** | PowerShell toast notification | Plays the system notification sound automatically |
| **Linux** | `notify-send --hint=string:sound-name:message` | Depends on the notification daemon — GNOME Shell and Plasma play it; Dunst ignores it by default but can be configured |

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

| Field | Value |
|-------|-------|
| Title | `Pi` |
| Body | `Done — "<user's prompt>"` (truncated to 72 chars) |

When no user prompt is found in the event messages, falls back to `Done — waiting for input`.

### Examples

| User prompt | Notification body |
|-------------|-------------------|
| `fix the login bug` | `Done — "fix the login bug"` |
| `refactor the auth module to use JWT` | `Done — "refactor the auth module to use JWT"` |
| `this is a very long user prompt that exceeds the maximum truncation length` | `Done — "this is a very long user prompt that exceeds the maximu…"` |
| _(no user prompt — e.g. follow-up turn)_ | `Done — waiting for input` |

## Startup message

On `session_start`, a one-line info notification shows which backends are active:

| Platform | Example output |
|----------|---------------|
| macOS + Ghostty | `Notify: desktop (macOS), OSC 777 (Background only)` |
| Linux + notify-send + Ghostty | `Notify: desktop (Linux), OSC 777 (Background only)` |
| Linux, no notify-send | `Notify: OSC 777 (Background only)` |
| Kitty (any OS) | `Notify: desktop (Linux), OSC 99 (Kitty) (Background only)` |
| WSL + Windows Terminal | `Notify: Windows Toast (Background only)` |

## Non-interactive modes

The `agent_end` handler checks `ctx.mode !== "tui"` and returns early for:

- `print` mode (`pi -p`)
- `rpc` mode (`pi --mode rpc`)
- `json` mode

This prevents subagents, SDK integrations, and automated runs from spamming notifications.

## Installation

The extension is auto-discovered from `extensions/notify.ts` via the project's `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

To use it globally (all projects), copy to `~/.pi/agent/extensions/notify.ts` instead.
