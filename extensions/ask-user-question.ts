/**
 * ask_user_question tool — Ask the user a multiple-choice question.
 *
 * Two focus zones: options list (arrow starts on first option)
 * and always-visible write-in field below.
 *
 * Single-select:
 *   ↑↓ navigate, Enter = select + submit
 *   Space holds option (to combine with write-in), ↓ to write-in
 *
 * Multi-select:
 *   ↑↓ navigate, Space toggle, Enter submit
 *   ↓ to write-in, Enter from write-in submits all
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskResult {
  question: string;
  selections: { label: string; description?: string }[];
  answer?: string;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AskOptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(
    Type.String({ description: "Optional description shown below the label" }),
  ),
});

export const AskParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(AskOptionSchema, {
    description: "Options the user can pick from",
  }),
  allowMultiple: Type.Optional(
    Type.Boolean({
      description: "Allow selecting multiple options (default: false)",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Color constants — single source of truth for theme color names
// ---------------------------------------------------------------------------

type ColorName = "accent" | "dim" | "muted" | "success" | "text" | "warning" | "toolTitle";

const C: Record<ColorName, ColorName> = {
  accent: "accent",
  dim: "dim",
  muted: "muted",
  success: "success",
  text: "text",
  warning: "warning",
  toolTitle: "toolTitle",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build the conversational content string from a result. */
export function buildContentSummary(result: AskResult): string {
  const selLabels = result.selections.map((s) => s.label);

  if (selLabels.length > 0 && result.answer) {
    return `The user chose ${selLabels.join(", ")} and added: "${result.answer}".`;
  }
  if (selLabels.length > 1) {
    return `The user selected: ${selLabels.join(", ")}.`;
  }
  if (selLabels.length === 1) {
    return `The user chose ${selLabels[0]}.`;
  }
  if (result.answer) {
    return `The user wrote: "${result.answer}".`;
  }
  return "The user provided no answer.";
}

// ---------------------------------------------------------------------------
// Prompt state — encapsulates all mutable state during the TUI interaction
// ---------------------------------------------------------------------------

interface PromptConfig {
  question: string;
  options: readonly AskOption[];
  allowMultiple: boolean;
  minSelections: number;
  maxSelections: number;
}

class PromptState {
  readonly selections = new Set<number>();
  cursorIndex = 0;
  writeinFocused = false;
  customAnswer: string | undefined;
  /** Transient feedback shown below the help bar (e.g. when submit is blocked). */
  feedback: string | undefined;

  constructor(readonly cfg: PromptConfig) {}

  get optionCount(): number {
    return this.cfg.options.length;
  }

  get lastOptionIndex(): number {
    return Math.max(0, this.optionCount - 1);
  }

  selectionCount(): number {
    return this.selections.size + (this.customAnswer ? 1 : 0);
  }

  canSubmit(): boolean {
    const count = this.selectionCount();
    if (count < this.cfg.minSelections) return false;
    if (this.cfg.maxSelections > 0 && this.selections.size > this.cfg.maxSelections) return false;
    return true;
  }

  /** Build the result object from current state. */
  toResult(): AskResult {
    const items: { label: string; description?: string }[] = [];
    for (const idx of [...this.selections].sort((a, b) => a - b)) {
      const opt = this.cfg.options[idx];
      if (opt) items.push({ label: opt.label, description: opt.description });
    }
    return { question: this.cfg.question, selections: items, answer: this.customAnswer };
  }

  /** Try to add a selection (for multi-select Space toggle). Returns false if at max. */
  toggleOption(index: number): boolean {
    if (this.selections.has(index)) {
      this.selections.delete(index);
      return true;
    }
    if (this.cfg.maxSelections <= 0 || this.selections.size < this.cfg.maxSelections) {
      this.selections.add(index);
      return true;
    }
    return false;
  }

  /** Select a single option (clears previous selections). */
  selectSingle(index: number): void {
    this.selections.clear();
    this.selections.add(index);
  }
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/** The visual mark for an option based on selection state. */
function optionMark(selected: boolean, multi: boolean): string {
  if (multi) return selected ? "☑" : "☐";
  return selected ? "●" : "○";
}

/** The colour name for an option line based on focus + selection state. */
function optionColor(focused: boolean, selected: boolean): ColorName {
  if (focused) return C.accent;
  if (selected) return C.success;
  return C.text;
}

/** Derive the help bar text from the current mode + focus. */
function keysHint(multi: boolean, writeinFocused: boolean): string {
  if (writeinFocused) {
    return "↑ to options • Enter to submit • Esc cancel";
  }
  if (multi) {
    return "↑↓ navigate • Space toggle • Enter submit • ↓ to write • Esc cancel";
  }
  return "↑↓ navigate • Enter select • Space hold • ↓ to write • Esc cancel";
}

// ---------------------------------------------------------------------------
// Minimal editor interface (what we use from pi-tui Editor)
// ---------------------------------------------------------------------------

interface EditorLike {
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
  onSubmit?: (value: string) => void;
}

// ---------------------------------------------------------------------------
// TUI render pipeline
// ---------------------------------------------------------------------------

function buildRender(
  tui: { requestRender: () => void },
  theme: { fg: (color: ColorName, text: string) => string },
  state: PromptState,
  editor: EditorLike,
) {
  let cachedLines: string[] | undefined;
  const fg = theme.fg.bind(theme);

  function invalidate(): void {
    cachedLines = undefined;
  }

  function refresh(): void {
    invalidate();
    tui.requestRender();
  }

  function addWrapped(lines: string[], text: string, width: number): void {
    lines.push(...wrapTextWithAnsi(text, width));
  }

  function addWrappedWithPrefix(
    lines: string[],
    prefix: string,
    text: string,
    width: number,
  ): void {
    const pw = visibleWidth(prefix);
    if (pw >= width) {
      addWrapped(lines, prefix + text, width);
      return;
    }
    const wrapped = wrapTextWithAnsi(text, width - pw);
    const cont = " ".repeat(pw);
    for (let i = 0; i < wrapped.length; i++) {
      lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
    }
  }

  function renderDivider(lines: string[], width: number): void {
    addWrapped(lines, fg(C.accent, "─".repeat(width)), width);
  }

  function renderOption(lines: string[], index: number, width: number): void {
    const opt = state.cfg.options[index];
    if (!opt) return;
    const isFocused = !state.writeinFocused && index === state.cursorIndex;
    const selected = state.selections.has(index);
    const mark = optionMark(selected, state.cfg.allowMultiple);
    const color = optionColor(isFocused, selected);
    const left = isFocused
      ? `  ${fg(C.accent, ">")} ${fg(selected ? C.success : C.dim, mark)}`
      : `    ${fg(selected ? C.success : C.dim, mark)}`;

    addWrappedWithPrefix(lines, `${left} `, fg(color, opt.label), width);
    if (opt.description) {
      addWrappedWithPrefix(lines, "       ", fg(C.muted, opt.description), width);
    }
  }

  function renderWritein(lines: string[], width: number): void {
    lines.push("");
    if (state.writeinFocused) {
      addWrappedWithPrefix(lines, " ", fg(C.accent, "▸ Write-in:"), width);
    } else {
      addWrappedWithPrefix(lines, " ", fg(C.muted, "  Write-in:"), width);
    }
    for (const line of editor.render(Math.max(1, width - 2))) {
      lines.push(` ${line}`);
    }
  }

  function renderStatus(lines: string[], width: number): void {
    const count = state.selectionCount();
    if (count < state.cfg.minSelections) {
      addWrappedWithPrefix(
        lines,
        " ",
        fg(C.warning, `Select at least ${state.cfg.minSelections} option(s) or type an answer`),
        width,
      );
    }
  }

  function renderHelp(lines: string[], width: number): void {
    if (state.feedback) {
      addWrappedWithPrefix(lines, " ", fg(C.warning, state.feedback), width);
      // clear feedback after rendering once
      state.feedback = undefined;
    } else {
      addWrappedWithPrefix(
        lines,
        " ",
        fg(C.dim, keysHint(state.cfg.allowMultiple, state.writeinFocused)),
        width,
      );
    }
  }

  function render(rw: number): string[] {
    if (cachedLines) return cachedLines;

    const width = Math.max(1, rw);
    const lines: string[] = [];

    renderDivider(lines, width);
    addWrappedWithPrefix(lines, " ", fg(C.text, state.cfg.question), width);

    if (state.cfg.allowMultiple) {
      const hints = [`min: ${state.cfg.minSelections}`, `max: ${state.cfg.maxSelections}`];
      addWrappedWithPrefix(lines, " ", fg(C.dim, `  (${hints.join(", ")})`), width);
    }

    lines.push("");

    for (let i = 0; i < state.optionCount; i++) {
      renderOption(lines, i, width);
    }

    renderWritein(lines, width);
    lines.push("");
    renderStatus(lines, width);
    renderHelp(lines, width);
    renderDivider(lines, width);

    cachedLines = lines;
    return lines;
  }

  return { render, invalidate, refresh };
}

// ---------------------------------------------------------------------------
// Input handler
// ---------------------------------------------------------------------------

function createInputHandler(
  state: PromptState,
  editor: EditorLike,
  refresh: () => void,
  done: (cancelled: boolean) => void,
): (data: string) => void {
  return function handleInput(data: string): void {
    // --- Write-in field focused ---
    if (state.writeinFocused) {
      if (matchesKey(data, Key.up)) {
        state.writeinFocused = false;
        state.cursorIndex = state.lastOptionIndex;
        refresh();
        return;
      }
      if (matchesKey(data, Key.escape)) {
        done(true);
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }

    // --- Options list focused ---
    if (matchesKey(data, Key.up)) {
      state.cursorIndex = Math.max(0, state.cursorIndex - 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.down)) {
      if (state.cursorIndex >= state.lastOptionIndex) {
        state.writeinFocused = true;
        refresh();
        return;
      }
      state.cursorIndex = Math.min(state.lastOptionIndex, state.cursorIndex + 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      done(true);
      return;
    }

    // --- Single-select mode ---
    if (!state.cfg.allowMultiple) {
      if (matchesKey(data, Key.enter) || data === "\r") {
        state.selectSingle(state.cursorIndex);
        const trimmed = editor.getText().trim();
        if (trimmed) state.customAnswer = trimmed;
        done(false);
        return;
      }
      if (matchesKey(data, "space")) {
        state.selectSingle(state.cursorIndex);
        refresh();
        return;
      }
      return;
    }

    // --- Multi-select mode ---
    if (matchesKey(data, "space")) {
      state.toggleOption(state.cursorIndex);
      refresh();
      return;
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      const trimmed = editor.getText().trim();
      if (trimmed) state.customAnswer = trimmed;
      if (state.canSubmit()) {
        done(false);
      } else {
        const count = state.selectionCount();
        state.feedback =
          count < state.cfg.minSelections
            ? "Select an option or type an answer"
            : `Maximum ${state.cfg.maxSelections} selection(s)`;
        refresh();
      }
      return;
    }
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function askExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    pi.registerTool({
      name: "ask_user_question",
      label: "AskUserQuestion",
      description:
        "Ask the user a multiple-choice question. The user can also type a custom answer. Use when you need a decision or input to proceed.",
      promptSnippet: "Ask the user a multiple-choice question",
      promptGuidelines: [
        "Use ask when you need the user to make a choice or provide input before continuing.",
      ],
      parameters: AskParams,

      async execute(_toolCallId, params, _signal, _onUpdate, execCtx) {
        const allowMultiple = params.allowMultiple ?? false;

        if (params.options.length === 0) {
          return {
            content: [{ type: "text", text: "Error: no options provided." }],
            details: { question: "", selections: [] } satisfies AskResult,
          };
        }

        const cfg: PromptConfig = {
          question: params.question,
          options: params.options,
          allowMultiple,
          minSelections: 1,
          maxSelections: allowMultiple ? params.options.length : 1,
        };

        const state = new PromptState(cfg);

        const cancelled = await execCtx.ui.custom<boolean>((tui, theme, _kb, done) => {
          const editorTheme: EditorTheme = {
            borderColor: (s) => theme.fg(C.accent, s),
            selectList: {
              selectedPrefix: (t) => theme.fg(C.accent, t),
              selectedText: (t) => theme.fg(C.accent, t),
              description: (t) => theme.fg(C.muted, t),
              scrollInfo: (t) => theme.fg(C.dim, t),
              noMatch: (t) => theme.fg(C.warning, t),
            },
          };

          const editor = new Editor(tui, editorTheme);

          const { render, invalidate, refresh } = buildRender(tui, theme, state, editor);

          editor.onSubmit = (value: string) => {
            const trimmed = value.trim();
            if (trimmed) state.customAnswer = trimmed;
            if (state.canSubmit()) {
              done(false);
            } else {
              // Restore the text and show feedback
              editor.setText(trimmed);
              state.feedback = state.customAnswer
                ? `Maximum ${cfg.maxSelections} selection(s)`
                : "Select an option or type an answer";
              refresh();
            }
          };

          const handleInput = createInputHandler(state, editor, refresh, done);

          return { render, invalidate, handleInput };
        });

        if (cancelled) {
          return {
            content: [{ type: "text", text: "The user cancelled." }],
            details: { question: params.question, selections: [] },
          };
        }

        const result = state.toResult();

        if (result.selections.length === 0 && !result.answer) {
          return {
            content: [{ type: "text", text: "The user declined to answer." }],
            details: result,
          };
        }

        const summary = buildContentSummary(result);
        return {
          content: [{ type: "text", text: summary }],
          details: result,
        };
      },

      // --- Custom rendering for tool-call card in conversation ---
      renderCall(args: Record<string, unknown>, theme, _context) {
        const opts = (args.options as AskOption[] | undefined) ?? [];
        const multi = (args.allowMultiple as boolean) ?? false;
        let text = theme.fg(C.toolTitle, theme.bold("ask_user_question "));
        text += theme.fg(multi ? C.accent : C.muted, multi ? "[multi] " : "[single] ");
        text += theme.fg(C.text, args.question as string);
        if (opts.length > 0) {
          text += "\n" + theme.fg(C.dim, opts.map((o) => o.label).join(", "));
        }
        return new Text(text, 0, 0);
      },

      renderResult(result, _options, theme, _context) {
        const details = result.details as AskResult | undefined;
        if (!details || (details.selections.length === 0 && !details.answer)) {
          const text = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (text.toLowerCase().includes("cancelled")) {
            return new Text(theme.fg(C.warning, "✗ Cancelled"), 0, 0);
          }
          return new Text(text, 0, 0);
        }
        const lines: string[] = [];
        for (const sel of details.selections) {
          let line = `${theme.fg(C.success, "✓")} ${theme.fg(C.accent, sel.label)}`;
          if (sel.description) {
            line += `  ${theme.fg(C.dim, sel.description)}`;
          }
          lines.push(line);
        }
        if (details.answer) {
          lines.push(
            `${theme.fg(C.success, "✓")} ${theme.fg(C.muted, "(wrote)")} ${theme.fg(C.accent, details.answer)}`,
          );
        }
        return new Text(lines.join("\n"), 0, 0);
      },
    });
  });
}
