/**
 * ask_user_question tool — Ask the user a multiple-choice question.
 *
 * See docs/ask-user-question.md for full documentation.
 *
 * Two focus zones: options list (arrow starts on first option)
 * and always-visible write-in field below.
 *
 * Single-select:
 *   ↑↓ navigate, Enter on option = select + submit
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
	description: Type.Optional(Type.String({ description: "Optional description shown below the label" })),
});

export const AskParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(AskOptionSchema, { description: "Options the user can pick from" }),
	allowMultiple: Type.Optional(
		Type.Boolean({ description: "Allow selecting multiple options (default: false)" }),
	),
});

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

			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const allowMultiple = params.allowMultiple ?? false;
				const minSelections = 1;
				const maxSelections = allowMultiple ? params.options.length : 1;

				if (params.options.length === 0) {
					return {
						content: [{ type: "text", text: "Error: no options provided." }],
						details: { question: "", selections: [] } satisfies AskResult,
					};
				}

				// --- state (shared between callback and result builder) ---
				const selections = new Set<number>();
				let customAnswer: string | undefined;

				const cancelled = await ctx.ui.custom<boolean>(
					(tui, theme, _kb, done) => {
					let currentOptionIndex = 0;
					let focusedField = false;
					let cachedLines: string[] | undefined;

					// Editor for write-in (always visible)
					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (t) => theme.fg("accent", t),
							selectedText: (t) => theme.fg("accent", t),
							description: (t) => theme.fg("muted", t),
							scrollInfo: (t) => theme.fg("dim", t),
							noMatch: (t) => theme.fg("warning", t),
						},
					};
					const editor = new Editor(tui, editorTheme);
					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) {
							customAnswer = trimmed;
						}
						// submitValue already cleared the buffer, so restore it
						// if we're not actually submitting
						if (canSubmit()) {
							done(false);
						} else {
							editor.setText(trimmed);
							refresh();
						}
					};

					// --- helpers ---
					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function displayOptions(): { label: string }[] {
						return params.options.map((o) => ({ label: o.label }));
					}

					function selectionCount(): number {
						return selections.size + (customAnswer ? 1 : 0);
					}

					function canSubmit(): boolean {
						const count = selectionCount();
						if (count < minSelections) return false;
						if (maxSelections > 0 && count > maxSelections) return false;
						return true;
					}

					// --- input ---
					function handleInput(data: string) {
						const maxOptIndex = params.options.length - 1;

						if (focusedField) {
							if (matchesKey(data, Key.up)) {
								focusedField = false;
								currentOptionIndex = Math.max(0, maxOptIndex);
								refresh();
								return;
							}
							if (matchesKey(data, Key.enter) || data === "\r" || data === "\n" || data === "\r\n") {
								const trimmed = editor.getText().trim();
								if (trimmed) customAnswer = trimmed;
								done(false);
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
							currentOptionIndex = Math.max(0, currentOptionIndex - 1);
							refresh();
							return;
						}
						if (matchesKey(data, Key.down)) {
							if (currentOptionIndex >= maxOptIndex) {
								// Move to text field
								focusedField = true;
								currentOptionIndex = -1;
								refresh();
								return;
							}
							currentOptionIndex = Math.min(maxOptIndex, currentOptionIndex + 1);
							refresh();
							return;
						}

						// --- Single-select mode ---
						if (!allowMultiple) {
							if ((matchesKey(data, Key.enter) || data === "\r" || data === "\n") && currentOptionIndex >= 0) {
								// Select option and submit (includes any custom text)
								selections.clear();
								selections.add(currentOptionIndex);
								const trimmed = editor.getText().trim();
								if (trimmed) customAnswer = trimmed;
								done(false);
								return;
							}

							// Space holds option without submitting (to combine with write-in)
							if (matchesKey(data, "space")) {
								selections.clear();
								selections.add(currentOptionIndex);
								refresh();
								return;
							}

							if (matchesKey(data, Key.escape)) {
								done(true);
							}
							return;
						}

						// --- Multi-select mode ---
						if (matchesKey(data, "space")) {
							if (selections.has(currentOptionIndex)) {
								selections.delete(currentOptionIndex);
							} else if (maxSelections <= 0 || selections.size < maxSelections) {
								selections.add(currentOptionIndex);
							}
							refresh();
							return;
						}

						if (matchesKey(data, Key.enter) || data === "\r" || data === "\n") {
							const trimmed = editor.getText().trim();
							if (trimmed) customAnswer = trimmed;
							if (canSubmit()) done(false);
							return;
						}

						if (matchesKey(data, Key.escape)) {
							done(true);
						}
					}

					// --- render ---
					function render(width: number): string[] {
						if (cachedLines) return cachedLines;

						const lines: string[] = [];
						const renderWidth = Math.max(1, width);
						const opts = displayOptions();

						function addWrapped(text: string) {
							lines.push(...wrapTextWithAnsi(text, renderWidth));
						}

						function addWrappedWithPrefix(prefix: string, text: string) {
							const pw = visibleWidth(prefix);
							if (pw >= renderWidth) {
								addWrapped(prefix + text);
								return;
							}
							const wrapped = wrapTextWithAnsi(text, renderWidth - pw);
							const cont = " ".repeat(pw);
							for (let i = 0; i < wrapped.length; i++) {
								lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
							}
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));
						addWrappedWithPrefix(" ", theme.fg("text", params.question));

						if (allowMultiple) {
							const hintParts: string[] = [];
							if (minSelections > 0) hintParts.push(`min: ${minSelections}`);
							if (maxSelections > 0) hintParts.push(`max: ${maxSelections}`);
							if (hintParts.length > 0) {
								addWrappedWithPrefix(" ", theme.fg("dim", `  (${hintParts.join(", ")})`));
							}
						}

						lines.push("");

						const fieldFocused = focusedField;

						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const isFocused = !fieldFocused && i === currentOptionIndex;

							if (allowMultiple) {
								const sel = selections.has(i);
								const mark = sel ? "☑" : "☐";
								const left = isFocused
									? `  ${theme.fg("accent", ">")} ${theme.fg(sel ? "success" : "dim", mark)}`
									: `    ${theme.fg(sel ? "success" : "dim", mark)}`;
								const color = isFocused ? "accent" : sel ? "success" : "text";
								addWrappedWithPrefix(`${left} `, theme.fg(color, opt.label));
								if (params.options[i]?.description) {
									addWrappedWithPrefix("       ", theme.fg("muted", params.options[i]!.description!));
								}
							} else {
								const sel = selections.has(i);
								const mark = sel ? "●" : "○";
								const left = isFocused
									? `  ${theme.fg("accent", ">")} ${theme.fg(sel ? "success" : "dim", mark)}`
									: `    ${theme.fg(sel ? "success" : "dim", mark)}`;
								const color = isFocused ? "accent" : sel ? "success" : "text";
								addWrappedWithPrefix(`${left} `, theme.fg(color, opt.label));
								if (params.options[i]?.description) {
									addWrappedWithPrefix("       ", theme.fg("muted", params.options[i]!.description!));
								}
							}
						}

						// Always-visible write-in field
						lines.push("");
						if (fieldFocused) {
							addWrappedWithPrefix(" ", theme.fg("accent", "▸ Write-in:"));
						} else {
							addWrappedWithPrefix(" ", theme.fg("muted", "  Write-in:"));
						}
						for (const line of editor.render(Math.max(1, renderWidth - 2))) {
							lines.push(` ${line}`);
						}

						lines.push("");

						const sCount = selectionCount();
						if (sCount < minSelections) {
							addWrappedWithPrefix(" ", theme.fg("warning", `Select at least ${minSelections} option(s)`));
						}

						if (allowMultiple) {
							if (fieldFocused) {
								addWrappedWithPrefix(" ", theme.fg("dim", "↑ to options • Enter to submit • Esc cancel"));
							} else {
								addWrappedWithPrefix(" ", theme.fg("dim", "↑↓ navigate • Space toggle • Enter submit • ↓ to write • Esc cancel"));
							}
						} else {
							if (fieldFocused) {
								addWrappedWithPrefix(" ", theme.fg("dim", "↑ to options • Enter to submit • Esc cancel"));
							} else {
								const parts = ["↑↓ navigate"];
								parts.push("Enter select");
								parts.push("Space hold");
								parts.push("↓ to write");
								parts.push("Esc cancel");
								addWrappedWithPrefix(" ", theme.fg("dim", parts.join(" • ")));
							}
						}

						lines.push(theme.fg("accent", "─".repeat(renderWidth)));

						cachedLines = lines;
						return lines;
					}

					return {
						render,
						invalidate: () => {
							cachedLines = undefined;
						},
						handleInput,
					};
				},
			);

			// Build result from captured state
			const buildSelection = (): AskResult => {
				const items: { label: string; description?: string }[] = [];
				const sorted = [...selections].sort((a, b) => a - b);
				for (const idx of sorted) {
					const opt = params.options[idx]!;
					items.push({ label: opt.label, description: opt.description });
				}
				return { question: params.question, selections: items, answer: customAnswer };
			};

			// cancelled is true when user pressed Esc without submitting
			const result = buildSelection();

			if (cancelled) {
				return {
					content: [{ type: "text", text: "The user cancelled." }],
					details: {
						question: params.question,
						selections: [],
					},
				};
			}

			if (result.selections.length === 0 && !result.answer) {
				return {
					content: [{ type: "text", text: "The user declined to answer." }],
					details: result,
				};
			}

			// Build conversational summary
			const content = buildContentSummary(result);

			return {
				content: [{ type: "text", text: content }],
				details: result,
			};
		},

		// --- custom rendering ---
		renderCall(args, theme, _context) {
			const opts = (args.options as AskOption[]) || [];
			const multi = args.allowMultiple ?? false;
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg(multi ? "accent" : "muted", multi ? "[multi] " : "[single] ");
			text += theme.fg("text", args.question);
			if (opts.length > 0) {
				text += "\n" + theme.fg("dim", opts.map((o) => o.label).join(", "));
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskResult | undefined;
			if (!details || (details.selections.length === 0 && !details.answer)) {
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				if (text.toLowerCase().includes("cancelled")) {
					return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
				}
				return new Text(text, 0, 0);
			}
			const lines: string[] = [];
			for (const sel of details.selections) {
				let line = `${theme.fg("success", "✓")} ${theme.fg("accent", sel.label)}`;
				if (sel.description) {
					line += `  ${theme.fg("dim", sel.description)}`;
				}
				lines.push(line);
			}
			if (details.answer) {
				lines.push(`${theme.fg("success", "✓")} ${theme.fg("muted", "(wrote)")} ${theme.fg("accent", details.answer)}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
	});
}
