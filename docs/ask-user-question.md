# ask-user-question

A pi extension that adds an `ask_user_question` tool for prompting the user with structured multiple-choice questions. A write-in field is always visible for custom text alongside the options.

- **Extension**: `extensions/ask-user-question.ts`
- **Tool name** (LLM-facing): `ask_user_question`
- **TUI label**: `AskUserQuestion`

## Parameters

| Parameter       | Type                      | Default | Description                      |
| --------------- | ------------------------- | ------- | -------------------------------- |
| `question`      | `string`                  | —       | The question to ask the user     |
| `options`       | `{label, description?}[]` | —       | Available choices                |
| `allowMultiple` | `boolean`                 | `false` | Allow selecting multiple options |

Write-in is **always on** — there is no `allowWriteIn` parameter. The user can always type a custom answer in addition to picking options. At least one selection (option or write-in) is required (or the user cancels with Esc).

## Usage examples

### Single-select (default)

```
ask_user_question({
  question: "What framework should we use?",
  options: [
    { label: "React", description: "Most popular, huge ecosystem" },
    { label: "Vue", description: "Lighter, easier to learn" },
    { label: "Svelte", description: "Fastest, smallest bundles" },
  ],
})
```

### Multi-select

```
ask_user_question({
  question: "Which features should we prioritize?",
  options: [
    { label: "Authentication" },
    { label: "Search" },
    { label: "Notifications" },
  ],
  allowMultiple: true,
})
```

## Result shape

The LLM receives a conversational text in `content` and minimal structured data in `details`:

- **`content`**: A natural language summary (e.g. `"The user chose React."`)
- **`details`**: Structured data

```typescript
interface AskResult {
  question: string;
  selections: { label: string; description?: string }[];
  answer?: string; // custom write-in, if any
}
```

### Examples

```
content: "The user chose React and added: \"Must support SSR\"."
details: {
  question: "What framework?",
  selections: [{ label: "React", description: "Popular, large ecosystem" }],
  answer: "Must support SSR"
}
```

```
content: "The user selected: Auth, Search."
details: {
  question: "Which features?",
  selections: [{ label: "Auth" }, { label: "Search" }]
}
```

```
content: "The user cancelled."
details: {
  question: "What framework?",
  selections: []
}
```

## UI layout

The tool renders a bordered panel with:

1. **Question** at the top
2. **Options list** — arrow starts on the first option
3. **Write-in field** — always visible below the options, has its own focus state
4. **Footer hints** — change depending on which area is focused

Two focus zones: the **options list** and the **write-in field**. The arrow (`>`) appears in the active zone.

## Keyboard controls

### Options focused (starting state)

| Key                  | Single-select                       | Multi-select                 |
| -------------------- | ----------------------------------- | ---------------------------- |
| **↑↓**               | Navigate options                    | Navigate options             |
| **Enter**            | Select highlighted option + submit  | Submit all toggled options   |
| **Space**            | Hold option (combine with write-in) | Toggle option on/off         |
| **↓** on last option | Move focus to write-in field        | Move focus to write-in field |
| **Esc**              | Cancel                              | Cancel                       |

### Write-in focused

| Key             | Action                                          |
| --------------- | ----------------------------------------------- |
| **↑**           | Move focus to options (last option)             |
| **Enter**       | **Submit** everything (options + write-in text) |
| **Esc**         | Cancel                                          |
| Letters/numbers | Type into the field                             |
| **Space**       | Type a space                                    |

### Write-in field

The write-in field is always visible. It's not a separate "mode" — it's rendered inline below the options. Only letters and numbers go into it; `↑↓`, `Enter`, `Space`, and `Esc` navigate or act on the UI. To type, you must be focused on the write-in field (press ↓ from the last option).

## Non-interactive modes

In print (`-p`), JSON, or RPC modes, the tool is **not registered** — the LLM won't see it in its available tools list. Only TUI mode registers it.

## Desktop notifications

When the agent calls `ask_user_question`, the `input-bridge.ts` extension emits a
`"user-input-needed"` event on `pi.events`. The `notify.ts` extension listens for this
event and fires a desktop notification if the terminal is unfocused. See
[`docs/notify.md`](notify.md) for the event contract.

## Registration

The tool registers in `session_start` only when `ctx.mode === "tui"`:

```typescript
pi.on("session_start", async (_event, ctx) => {
  if (ctx.mode !== "tui") return;
  pi.registerTool({ name: "ask_user_question", ... });
});
```
