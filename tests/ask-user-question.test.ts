import { describe, it, expect, vi, beforeEach } from "vitest";
import askExtension, {
	buildContentSummary,
	AskParams,
	AskOptionSchema,
} from "../extensions/ask-user-question";
import { Key, matchesKey } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Mock pi-tui Editor so we can drive interactive behavior in tests
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
	const actual: any = await importOriginal();

	class MockEditor {
		focused = true;
		onSubmit: ((value: string) => void) | undefined;
		disableSubmit = false;
		private _text = "";

		getText() {
			return this._text;
		}
		setText(t: string) {
			this._text = t;
		}
		handleInput(data: string) {
			// Plain Enter → submit
			if (matchesKey(data, Key.enter) || data === "\r") {
				if (!this.disableSubmit && this.onSubmit) {
					const value = this._text;
					this._text = "";
					this.onSubmit(value);
				}
				return;
			}
			// Regular printable chars
			if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
				this._text += data;
			}
		}
		render() {
			return [this._text || " "];
		}
		invalidate = () => {};
		setPaddingX = () => {};
		addToHistory = () => {};
	}

	return {
		...actual,
		Editor: MockEditor as any,
	};
});

// ---------------------------------------------------------------------------
// Interactive harness — drives the tool's handleInput callback
// ---------------------------------------------------------------------------

interface Harness {
	/** Await this to get the execute result (resolves when done() is called) */
	result: Promise<any>;
	doneSpy: ReturnType<typeof vi.fn>;
	pressUp: () => void;
	pressDown: () => void;
	pressKey: (data: string) => void;
	pressEnter: () => void;
	pressShiftEnter: () => void;
	pressAltEnter: () => void;
	pressSpace: () => void;
	pressEsc: () => void;
	type: (text: string) => void;
}

function createHarness(
	question: string,
	options: { label: string; description?: string }[],
	allowMultiple?: boolean,
): Harness {
	let handleInput: ((data: string) => void) | undefined;
	const doneSpy = vi.fn();

	const registerTool = vi.fn();
	const on = vi.fn();
	askExtension({ on, registerTool } as any);
	const handler = on.mock.calls[0][1];
	handler(undefined, { mode: "tui" });
	const tool = registerTool.mock.calls[0][0];

	const mockUiCustom = vi.fn().mockImplementation(
		(callback: (tui: any, theme: any, kb: any, done: (v: boolean) => void) => any) =>
			new Promise<boolean>((resolve) => {
				const done = (value: boolean) => {
					doneSpy(value);
					resolve(value);
				};
				const tui = { requestRender: vi.fn() };
				const theme = {
					fg: (_color: string, s: string) => s,
					bold: (s: string) => s,
				};
				const result = callback(tui, theme, {}, done);
				handleInput = result.handleInput;
			}),
	);

	const execPromise = tool.execute(
		"id",
		{ question, options, allowMultiple },
		undefined,
		undefined,
		{ mode: "tui", ui: { custom: mockUiCustom } },
	);

	// Small delay to let the microtask queue flush so handleInput is set
	// before tests drive it.
	return {
		result: execPromise,
		doneSpy,
		pressUp: () => handleInput!("\x1b[A"),
		pressDown: () => handleInput!("\x1b[B"),
		pressKey: (data: string) => handleInput!(data),
		// Don't intercept Enter — it flows to the Editor which
		// calls onSubmit → done(false) for plain Enter.
		// Shift+Enter / Alt+Enter are intercepted above to insert \n.
		pressEnter: () => handleInput!("\r"),
		pressSpace: () => handleInput!(" "),
		pressEsc: () => handleInput!("\x1b"),
		type: (text: string) => {
			for (const char of text) handleInput!(char);
		},
	};
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
describe("registration", () => {
	it("registers tool in TUI mode", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		askExtension({ on, registerTool } as any);
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));

		const handler = on.mock.calls[0][1];
		await handler(undefined, { mode: "tui" });

		expect(registerTool).toHaveBeenCalledOnce();
		const tool = registerTool.mock.calls[0][0];
		expect(tool.name).toBe("ask_user_question");
		expect(tool.label).toBe("AskUserQuestion");
		expect(tool.parameters).toBe(AskParams);
	});

	it("skips registration in non-TUI modes", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		askExtension({ on, registerTool } as any);
		const handler = on.mock.calls[0][1];
		for (const mode of ["print", "json", "rpc"]) {
			await handler(undefined, { mode });
		}
		expect(registerTool).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Schema structure
// ---------------------------------------------------------------------------
describe("schema", () => {
	it("AskParams has question, options, allowMultiple", () => {
		expect(AskParams.properties).toHaveProperty("question");
		expect(AskParams.properties).toHaveProperty("options");
		expect(AskParams.properties).toHaveProperty("allowMultiple");
	});
	it("AskOptionSchema has label and optional description", () => {
		expect(AskOptionSchema.properties).toHaveProperty("label");
		expect(AskOptionSchema.properties).toHaveProperty("description");
	});
});

// ---------------------------------------------------------------------------
// buildContentSummary (pure)
// ---------------------------------------------------------------------------
describe("buildContentSummary", () => {
	it("single selection", () =>
		expect(buildContentSummary({ question: "?", selections: [{ label: "A" }] })).toBe("The user chose A."));
	it("multiple selections", () =>
		expect(buildContentSummary({ question: "?", selections: [{ label: "A" }, { label: "B" }] })).toBe(
			"The user selected: A, B.",
		));
	it("selection + write-in", () =>
		expect(
			buildContentSummary({
				question: "?",
				selections: [{ label: "A" }],
				answer: "notes",
			}),
		).toBe('The user chose A and added: "notes".'));
	it("write-in only", () =>
		expect(
			buildContentSummary({ question: "?", selections: [], answer: "custom" }),
		).toBe('The user wrote: "custom".'));
	it("empty", () =>
		expect(buildContentSummary({ question: "?", selections: [] })).toBe("The user provided no answer."));
});

// ---------------------------------------------------------------------------
// Interactive: single-select
// ---------------------------------------------------------------------------
describe("interactive — single-select", () => {
	it("Enter on first option selects Alpha and submits", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }, { label: "Beta" }]);
		h.pressEnter();
		const r = await h.result;
		expect(h.doneSpy).toHaveBeenCalledWith(false);
		expect(r.content[0].text).toBe("The user chose Alpha.");
		expect(r.details.selections).toEqual([{ label: "Alpha" }]);
	});

	it("↓ ↓ Enter selects Gamma", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }, { label: "Beta" }, { label: "Gamma" }]);
		h.pressDown();
		h.pressDown();
		h.pressEnter();
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "Gamma" }]);
	});

	it("Space holds option without submitting", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }, { label: "Beta" }]);
		h.pressSpace();
		// done should NOT have been called yet
		expect(h.doneSpy).not.toHaveBeenCalled();
		// Now Enter submits both held option + write-in
		h.pressEnter();
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "Alpha" }]);
	});

	it("Enter on option with write-in captures both", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }, { label: "Beta" }]);
		// Move to write-in, type
		h.pressDown();
		h.pressDown(); // past last option → write-in
		h.type("custom text");
		// Move back up and submit
		h.pressUp(); // back to Beta
		h.pressUp(); // back to Alpha
		h.pressEnter();
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "Alpha" }]);
		expect(r.details.answer).toBe("custom text");
		expect(r.content[0].text).toBe('The user chose Alpha and added: "custom text".');
	});

	it("Enter from write-in submits (always)", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }, { label: "Beta" }]);
		h.pressDown();
		h.pressDown(); // write-in
		h.type("hello");
		h.pressEnter(); // submits from write-in
		const r = await h.result;
		expect(r.details.answer).toBe("hello");
		expect(r.details.selections).toEqual([]);
		expect(r.content[0].text).toBe('The user wrote: "hello".');
	});

	it("Enter from empty write-in does nothing (needs selection or text)", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }]);
		h.pressDown(); // write-in
		h.pressEnter(); // empty, no selections → canSubmit false, done not called
		expect(h.doneSpy).not.toHaveBeenCalled();
	});

	it("Esc cancels from options", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }]);
		h.pressEsc();
		const r = await h.result;
		expect(h.doneSpy).toHaveBeenCalledWith(true);
		expect(r.content[0].text).toBe("The user cancelled.");
	});

	it("Esc cancels from write-in", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }]);
		h.pressDown(); // write-in
		h.type("some text");
		h.pressEsc();
		const r = await h.result;
		expect(h.doneSpy).toHaveBeenCalledWith(true);
		expect(r.content[0].text).toBe("The user cancelled.");
	});

	it("↓ past last option moves to write-in, ↑ goes back", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }, { label: "Beta" }]);
		// Start: Alpha highlighted
		h.pressDown(); // Beta
		h.pressDown(); // write-in
		h.type("from write-in");
		h.pressUp(); // back to Beta
		h.pressEnter(); // submit with Beta
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "Beta" }]);
		expect(r.details.answer).toBe("from write-in");
	});

	it("typing on options does NOT auto-focus write-in", async () => {
		const h = createHarness("Q", [{ label: "Alpha" }]);
		h.type("abc"); // ignored when options focused
		h.pressEnter(); // submits immediately (Alpha selected)
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "Alpha" }]);
		expect(r.details.answer).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Interactive: multi-select
// ---------------------------------------------------------------------------
describe("interactive — multi-select", () => {
	it("Space toggles options, Enter submits all", async () => {
		const h = createHarness("Q", [{ label: "A" }, { label: "B" }, { label: "C" }], true);
		h.pressSpace(); // toggle A on
		h.pressDown();
		h.pressSpace(); // toggle B on
		h.pressDown();
		h.pressSpace(); // toggle C on
		h.pressEnter();
		const r = await h.result;
		expect(r.details.selections).toHaveLength(3);
	});

	it("Space toggles off, then toggles another on", async () => {
		const h = createHarness("Q", [{ label: "A" }, { label: "B" }], true);
		h.pressSpace(); // A on
		h.pressSpace(); // A off
		h.pressDown();
		h.pressSpace(); // B on
		h.pressEnter();
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "B" }]);
	});

	it("Enter from write-in submits with selections", async () => {
		const h = createHarness("Q", [{ label: "A" }, { label: "B" }], true);
		h.pressSpace(); // A on
		h.pressDown();
		h.pressDown(); // write-in
		h.type("notes");
		h.pressEnter();
		const r = await h.result;
		expect(r.details.selections).toHaveLength(1);
		expect(r.details.answer).toBe("notes");
	});

	it("Enter from options submits with write-in text", async () => {
		const h = createHarness("Q", [{ label: "A" }, { label: "B" }], true);
		h.pressDown();
		h.pressDown(); // write-in
		h.type("custom text");
		h.pressUp(); // back to B
		h.pressSpace(); // toggle B on
		h.pressEnter(); // submit B + text
		const r = await h.result;
		expect(r.details.selections).toEqual([{ label: "B" }]);
		expect(r.details.answer).toBe("custom text");
	});

	it("Esc cancels", async () => {
		const h = createHarness("Q", [{ label: "A" }], true);
		h.pressSpace();
		h.pressEsc();
		const r = await h.result;
		expect(r.content[0].text).toBe("The user cancelled.");
	});
});

// ---------------------------------------------------------------------------
// Error path: empty options
// ---------------------------------------------------------------------------
describe("execute — empty options", () => {
	it("returns error", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		askExtension({ on, registerTool } as any);
		const handler = on.mock.calls[0][1];
		await handler(undefined, { mode: "tui" });
		const tool = registerTool.mock.calls[0][0];

		const result = await tool.execute(
			"id",
			{ question: "?", options: [] },
			undefined,
			undefined,
			{ mode: "tui", ui: { custom: vi.fn() } },
		);
		expect(result).toEqual({
			content: [{ type: "text", text: "Error: no options provided." }],
			details: { question: "", selections: [] },
		});
	});
});