import { describe, it, expect, vi } from "vitest";
import askExtension, {
	buildContentSummary,
	AskParams,
	AskOptionSchema,
} from "../extensions/ask-user-question";

// ---------------------------------------------------------------------------
// Registration logic
// ---------------------------------------------------------------------------

describe("registration", () => {
	it("registers tool in TUI mode", async () => {
		const registerTool = vi.fn();
		const on = vi.fn();
		askExtension({ on, registerTool } as any);

		expect(on).toHaveBeenCalledOnce();
		expect(on).toHaveBeenCalledWith("session_start", expect.any(Function));

		const handler = on.mock.calls[0][1];
		await handler(undefined, { mode: "tui" });

		expect(registerTool).toHaveBeenCalledOnce();
		const tool = registerTool.mock.calls[0][0];
		expect(tool.name).toBe("ask_user_question");
		expect(tool.label).toBe("AskUserQuestion");
		expect(tool.description).toBeTruthy();
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

// Schema tests check structure — TypeBox v1.2 uses type-level operations
// Runtime validation is handled by the pi framework
describe("schema", () => {
	it("AskParams exports with correct keys", () => {
		expect(AskParams).toHaveProperty("type", "object");
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
// buildContentSummary — pure function, no mocking needed
// ---------------------------------------------------------------------------

describe("buildContentSummary", () => {
	it('returns "chose" for single selection', () => {
		const result = buildContentSummary({
			question: "Framework?",
			selections: [{ label: "React" }],
		});
		expect(result).toBe("The user chose React.");
	});

	it('returns "selected" for multiple selections', () => {
		const result = buildContentSummary({
			question: "Features?",
			selections: [{ label: "Auth" }, { label: "Search" }],
		});
		expect(result).toBe("The user selected: Auth, Search.");
	});

	it('returns "chose and added" for selection + write-in', () => {
		const result = buildContentSummary({
			question: "Framework?",
			selections: [{ label: "React", description: "Popular" }],
			answer: "Must support SSR",
		});
		expect(result).toBe('The user chose React and added: "Must support SSR".');
	});

	it('returns "wrote" for write-in only', () => {
		const result = buildContentSummary({
			question: "Thoughts?",
			selections: [],
			answer: "I like it",
		});
		expect(result).toBe('The user wrote: "I like it".');
	});

	it('returns "no answer" for empty result', () => {
		const result = buildContentSummary({
			question: "Any?",
			selections: [],
		});
		expect(result).toBe("The user provided no answer.");
	});
});

// ---------------------------------------------------------------------------
// execute — mock-based tests
// ---------------------------------------------------------------------------

describe("execute", () => {
	function makeTool() {
		const registerTool = vi.fn();
		const on = vi.fn();
		askExtension({ on, registerTool } as any);
		const handler = on.mock.calls[0][1];
		return { handler, registerTool, on };
	}

	it("returns error when no options", async () => {
		const { handler, registerTool } = makeTool();
		await handler(undefined, { mode: "tui" });
		const tool = registerTool.mock.calls[0][0];

		const result = await tool.execute(
			"id",
			{ question: "Any?", options: [] },
			undefined,
			undefined,
			{ mode: "tui", ui: { custom: vi.fn() } },
		);

		expect(result).toEqual({
			content: [{ type: "text", text: "Error: no options provided." }],
			details: { question: "", selections: [] },
		});
	});

	it("returns cancelled when ui.custom resolves true", async () => {
		const { handler, registerTool } = makeTool();
		await handler(undefined, { mode: "tui" });
		const tool = registerTool.mock.calls[0][0];

		const result = await tool.execute(
			"id",
			{ question: "Pick?", options: [{ label: "A" }] },
			undefined,
			undefined,
			{ mode: "tui", ui: { custom: vi.fn().mockResolvedValue(true) } },
		);

		expect(result).toMatchObject({
			content: [{ type: "text", text: "The user cancelled." }],
		});
		expect(result.details).toHaveProperty("selections", []);
	});

	it("returns declined when user submitted nothing", async () => {
		const { handler, registerTool } = makeTool();
		await handler(undefined, { mode: "tui" });
		const tool = registerTool.mock.calls[0][0];

		const result = await tool.execute(
			"id",
			{ question: "Pick?", options: [{ label: "A" }] },
			undefined,
			undefined,
			{ mode: "tui", ui: { custom: vi.fn().mockResolvedValue(false) } },
		);

		// selections is empty Set (never populated), customAnswer undefined
		expect(result.content[0].text).toMatch(/declined|no answer/);
	});

	it("returns results when ui.custom resolves false with selections", async () => {
		// To properly test this we'd need to drive the interactive callback.
		// For now, the pure-function tests above cover the content building.
		// This test verifies the non-error paths resolve without throwing.
		const { handler, registerTool } = makeTool();
		await handler(undefined, { mode: "tui" });
		const tool = registerTool.mock.calls[0][0];

		await expect(
			tool.execute(
				"id",
				{ question: "Pick?", options: [{ label: "A" }, { label: "B" }] },
				undefined,
				undefined,
				{ mode: "tui", ui: { custom: vi.fn().mockResolvedValue(false) } },
			),
		).resolves.toBeDefined();
	});
});