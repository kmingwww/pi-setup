import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { execFile as ExecFileFn } from "node:child_process";

// ---------------------------------------------------------------------------
// Controllable mock for node:child_process
// ---------------------------------------------------------------------------

let _execFileImpl: typeof ExecFileFn | null = null;

vi.mock("node:child_process", () => ({
	execFile: (...args: any[]) => {
		if (!_execFileImpl) throw new Error("execFile mock not configured — call setExecFileImpl() first");
		return (_execFileImpl as Function)(...args);
	},
}));

function setExecFileImpl(fn: typeof ExecFileFn) {
	_execFileImpl = fn;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface HandlerMap {
	agent_end?: Function;
	session_start?: Function;
	session_shutdown?: Function;
	tool_call?: Function;
	agent_start?: Function;
	tool_result?: Function;
}

/** Create a minimal mock ExtensionAPI and capture registered handlers. */
function createMockPi(): {
	on: ReturnType<typeof vi.fn>;
	handlers: HandlerMap;
} {
	const handlers: HandlerMap = {};
	return {
		handlers,
		on: vi.fn((event: string, handler: Function) => {
			(handlers as any)[event] = handler;
		}),
	};
}

function tuiCtx() {
	return { mode: "tui" as const, ui: { notify: vi.fn() } };
}

function nonTuiCtx(mode: string) {
	return { mode, ui: { notify: vi.fn() } };
}

// ---------------------------------------------------------------------------
// Message helpers — simulate AgentMessage arrays from agent_end
// ---------------------------------------------------------------------------

function userMsg(text: string) {
	return { role: "user", content: text, timestamp: Date.now() };
}

function userMsgBlocks(...texts: string[]) {
	return {
		role: "user",
		content: texts.map((t) => ({ type: "text" as const, text: t })),
		timestamp: Date.now(),
	};
}

function assistantMsg(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text" as const, text }],
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function toolMsg(result: string) {
	return {
		role: "tool",
		content: [{ type: "text" as const, text: result }],
		toolCallId: "call_1",
		toolName: "bash",
		timestamp: Date.now(),
	};
}

/** Build a mock agent_end event. */
function agentEndEvent(messages: Array<{ role: string; content: unknown }>) {
	return { messages };
}

/** Expected notification body when given a user prompt. */
function expectedBody(prompt: string): string {
	const maxLen = 72;
	const truncated = prompt.length > maxLen ? prompt.slice(0, maxLen - 3).trimEnd() + "…" : prompt;
	return `Done — "${truncated}"`;
}

/** Expected fallback body when no user prompt is found. */
const FALLBACK_BODY = "Done — waiting for input";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notify extension", () => {
	let originalEnv: typeof process.env;
	let stdoutWrite: ReturnType<typeof vi.fn>;

	let stdinOn: ReturnType<typeof vi.fn>;
	let stdinRemove: ReturnType<typeof vi.fn>;
	let stdinListeners: Map<string, Function>;

	beforeEach(() => {
		originalEnv = { ...process.env };
		vi.resetModules();
		stdoutWrite = vi.fn();
		vi.spyOn(process.stdout, "write").mockImplementation(stdoutWrite);

		stdinListeners = new Map();
		stdinOn = vi.spyOn(process.stdin, "on").mockImplementation((event, listener) => {
			stdinListeners.set(event as string, listener as Function);
			return process.stdin;
		});
		stdinRemove = vi.spyOn(process.stdin, "removeListener").mockImplementation((event, listener) => {
			if (stdinListeners.get(event as string) === listener) {
				stdinListeners.delete(event as string);
			}
			return process.stdin;
		});
	});

	afterEach(() => {
		process.env = originalEnv;
		vi.restoreAllMocks();
	});

	/** Simulate terminal focus out (alt-tab away) */
	function simulateFocusOut() {
		const handler = stdinListeners.get("data");
		if (handler) handler(Buffer.from("\x1b[O"));
	}

	/** Simulate terminal focus in (alt-tab back) */
	function simulateFocusIn() {
		const handler = stdinListeners.get("data");
		if (handler) handler(Buffer.from("\x1b[I"));
	}

	// -----------------------------------------------------------------------
	// Helper: load the extension with controlled binary probes
	// -----------------------------------------------------------------------
	async function loadNotify(probes: {
		notifySend?: boolean;
		powershell?: boolean;
		osascript?: boolean;
	} = {}) {
		const { notifySend = false, powershell = false, osascript = false } = probes;

		setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
			if (cmd === "which" && args[0] === "notify-send") {
				cb?.(notifySend ? null : new Error("not found"));
				return undefined as any;
			}
			if (cmd === "which" && args[0] === "powershell.exe") {
				cb?.(powershell ? null : new Error("not found"));
				return undefined as any;
			}
			if (cmd === "which" && args[0] === "osascript") {
				cb?.(osascript ? null : new Error("not found"));
				return undefined as any;
			}
			// Actual notification spawns — succeed silently
			cb?.(null);
			return undefined as any;
		}) as any);

		const mod = await import("../extensions/notify");
		return mod.default;
	}

	// ===================================================================
	// Registration
	// ===================================================================
	describe("registration", () => {
		it("registers expected event handlers", async () => {
			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			expect(pi.on).toHaveBeenCalledTimes(6);
			expect(pi.handlers.agent_end).toBeDefined();
			expect(pi.handlers.session_start).toBeDefined();
			expect(pi.handlers.session_shutdown).toBeDefined();
			expect(pi.handlers.tool_call).toBeDefined();
			expect(pi.handlers.agent_start).toBeDefined();
			expect(pi.handlers.tool_result).toBeDefined();
		});
	});

	// ===================================================================
	// agent_end — TUI mode: Linux
	// ===================================================================
	describe("agent_end in TUI mode — Linux", () => {
		it("writes OSC 777 escape with context from last user prompt", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = agentEndEvent([userMsg("fix the login bug"), assistantMsg("done"), toolMsg("ok")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(`\x1b]777;notify;Pi;${expectedBody("fix the login bug")}\x07`),
			);
		});

		it("falls back to generic body when no user message exists", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = agentEndEvent([assistantMsg("Hello!")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(`\x1b]777;notify;Pi;${FALLBACK_BODY}\x07`),
			);
		});

		it("extracts text from content-block user messages", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = agentEndEvent([userMsgBlocks("fix the", "login bug")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(`Done — "fix the login bug"`),
			);
		});

		it("truncates long prompts to 72 chars", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const longPrompt = "this is a very long user prompt that exceeds the maximum truncation length";
			// 74 chars → truncated to 72: first 69 chars + "…"

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = agentEndEvent([userMsg(longPrompt)]);
			await pi.handlers.agent_end!(event, tuiCtx());

			const call = stdoutWrite.mock.calls[0]?.[0] as string;
			expect(call).toContain("Done — \"");
			// Should end with "…" + the escape sequence (not the full prompt)
			expect(call).toContain("…\"\x07");
			// Should not contain the full untruncated text
			expect(call).not.toContain(longPrompt);
		});

		it("spawns notify-send with correct args, sound hint, and context body", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			const spawned: string[][] = [];
			setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
				spawned.push([cmd, ...args]);
				cb?.(null);
				return undefined as any;
			}) as any);

			const event = agentEndEvent([userMsg("refactor auth module")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			const notifySendCall = spawned.find((s) => s[0] === "notify-send");
			expect(notifySendCall).toBeDefined();
			expect(notifySendCall![1]).toBe("--app-name=pi");
			expect(notifySendCall![2]).toBe("--hint=string:sound-name:message");
			expect(notifySendCall![3]).toBe("Pi");
			expect(notifySendCall![4]).toBe(expectedBody("refactor auth module"));
		});

		it("does NOT spawn notify-send when it was not found during probe", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: false });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			const spawned: string[][] = [];
			setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
				spawned.push([cmd, ...args]);
				cb?.(null);
				return undefined as any;
			}) as any);

			const event = agentEndEvent([userMsg("hello")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			const notifySendCalls = spawned.filter((s) => s[0] === "notify-send");
			expect(notifySendCalls).toHaveLength(0);
		});
	});

	// ===================================================================
	// agent_end — TUI mode: macOS
	// ===================================================================
	describe("agent_end in TUI mode — macOS", () => {
		it("spawns osascript with context body and default sound", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ osascript: true, notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			const spawned: string[][] = [];
			setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
				spawned.push([cmd, ...args]);
				cb?.(null);
				return undefined as any;
			}) as any);

			const body = expectedBody("add dark mode toggle");
			const event = agentEndEvent([userMsg("add dark mode toggle")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			const osaCall = spawned.find((s) => s[0] === "osascript");
			expect(osaCall).toBeDefined();
			expect(osaCall![1]).toBe("-e");
			expect(osaCall![2]).toContain(`display notification "${body}"`);
			expect(osaCall![2]).toContain('with title "Pi"');
			expect(osaCall![2]).toContain('sound name "default"');

			// macOS takes priority over Linux — notify-send should NOT be called
			const notifySendCalls = spawned.filter((s) => s[0] === "notify-send");
			expect(notifySendCalls).toHaveLength(0);
		});
	});

	// ===================================================================
	// agent_end — TUI mode: Kitty
	// ===================================================================
	describe("agent_end in TUI mode — Kitty", () => {
		it("writes OSC 99 escapes with context body", async () => {
			delete process.env.WT_SESSION;
			process.env.KITTY_WINDOW_ID = "1";

			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const body = expectedBody("update dependencies");
			const event = agentEndEvent([userMsg("update dependencies")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining("\x1b]99;i=1:d=0;Pi\x1b\\"),
			);
			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(`\x1b]99;i=1:p=body;${body}\x1b\\`),
			);
		});
	});

	// ===================================================================
	// agent_end — TUI mode: Windows Terminal
	// ===================================================================
	describe("agent_end in TUI mode — Windows Terminal", () => {
		it("spawns powershell.exe when WT_SESSION is set and powershell is available", async () => {
			delete process.env.KITTY_WINDOW_ID;
			process.env.WT_SESSION = "abc123";

			const pi = createMockPi();
			const factory = await loadNotify({ powershell: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			const spawned: string[][] = [];
			setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
				spawned.push([cmd, ...args]);
				cb?.(null);
				return undefined as any;
			}) as any);

			stdoutWrite.mockClear();
			const body = expectedBody("list files");
			const event = agentEndEvent([userMsg("list files")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			const powershellCall = spawned.find((s) => s[0] === "powershell.exe");
			expect(powershellCall).toBeDefined();
			expect(powershellCall![1]).toBe("-NoProfile");
			expect(powershellCall![2]).toBe("-Command");
			expect(powershellCall![3]).toContain("Windows.UI.Notifications");
			expect(powershellCall![3]).toContain(body);
			// No OSC writes when Windows Terminal is detected
			expect(stdoutWrite).not.toHaveBeenCalled();
		});

		it("falls back to OSC 777 when WT_SESSION is set but powershell.exe is not found", async () => {
			delete process.env.KITTY_WINDOW_ID;
			process.env.WT_SESSION = "abc123";

			const pi = createMockPi();
			const factory = await loadNotify({ powershell: false });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const body = expectedBody("check status");
			const event = agentEndEvent([userMsg("check status")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(`\x1b]777;notify;Pi;${body}\x07`),
			);
		});
	});

	// ===================================================================
	// agent_end — non-TUI mode (subagents, RPC, print, json)
	// ===================================================================
	describe("agent_end in non-TUI mode", () => {
		it.each(["print", "rpc", "json"] as const)(
			"does nothing in %s mode",
			async (mode) => {
				const pi = createMockPi();
				const factory = await loadNotify({ notifySend: true });
				await factory(pi as any);

				stdoutWrite.mockClear();

				// We don't simulateFocusOut here because non-TUI modes skip session_start listener attachment
				const event = agentEndEvent([userMsg("hello")]);
				await pi.handlers.agent_end!(event, { mode, ui: { notify: vi.fn() } });

				expect(stdoutWrite).not.toHaveBeenCalled();
			},
		);
	});

	// ===================================================================
	// Context extraction
	// ===================================================================
	describe("context extraction", () => {
		it("finds the last user message when other messages follow", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = agentEndEvent([
				userMsg("do X"),
				assistantMsg("ok"),
				toolMsg("done"),
				assistantMsg("more"),
			]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(expectedBody("do X")),
			);
		});

		it("picks the last user message when multiple exist", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = agentEndEvent([
				userMsg("first prompt"),
				assistantMsg("a"),
				userMsg("second prompt"),
				assistantMsg("b"),
			]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(expectedBody("second prompt")),
			);
		});
	});

	// ===================================================================
	// session_start — backends info
	// ===================================================================
	describe("session_start — backends info", () => {
		it("notifies with desktop (Linux) and OSC backends", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			const ctx = tuiCtx();
			await pi.handlers.session_start!(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("desktop (Linux)"),
				"info",
			);
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("OSC 777"),
				"info",
			);
		});

		it("notifies with desktop (macOS) when osascript is found", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ osascript: true });
			await factory(pi as any);

			const ctx = tuiCtx();
			await pi.handlers.session_start!(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("desktop (macOS)"),
				"info",
			);
		});

		it("reports only OSC 777 when no other backends are found", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: false, osascript: false });
			await factory(pi as any);

			const ctx = tuiCtx();
			await pi.handlers.session_start!(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"Notify: OSC 777 (Background only)",
				"info",
			);
		});

		it("reports Kitty backend when KITTY_WINDOW_ID is set", async () => {
			delete process.env.WT_SESSION;
			process.env.KITTY_WINDOW_ID = "1";

			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			const ctx = tuiCtx();
			await pi.handlers.session_start!(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("OSC 99 (Kitty)"),
				"info",
			);
		});

		it("reports Windows Toast backend when WT_SESSION + powershell are available", async () => {
			delete process.env.KITTY_WINDOW_ID;
			process.env.WT_SESSION = "abc123";

			const pi = createMockPi();
			const factory = await loadNotify({ powershell: true });
			await factory(pi as any);

			const ctx = tuiCtx();
			await pi.handlers.session_start!(undefined, ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("Windows Toast"),
				"info",
			);
		});
	});

	// ===================================================================
	// Backend selection priority
	// ===================================================================
	describe("backend selection priority", () => {
		it("WT_SESSION takes priority over KITTY_WINDOW_ID", async () => {
			process.env.WT_SESSION = "abc";
			process.env.KITTY_WINDOW_ID = "1";

			const pi = createMockPi();
			const factory = await loadNotify({ powershell: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
				cb?.(null);
				return undefined as any;
			}) as any);

			stdoutWrite.mockClear();
			const event = agentEndEvent([userMsg("test")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).not.toHaveBeenCalled();
		});

		it("KITTY_WINDOW_ID takes priority over default OSC 777", async () => {
			delete process.env.WT_SESSION;
			process.env.KITTY_WINDOW_ID = "1";

			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			stdoutWrite.mockClear();
			const event = agentEndEvent([userMsg("test")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledTimes(2);
			expect(stdoutWrite).not.toHaveBeenCalledWith(
				expect.stringContaining("\x1b]777"),
			);
		});

		it("macOS desktop takes priority over Linux desktop when both are present", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ osascript: true, notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();

			const spawned: string[][] = [];
			setExecFileImpl(((cmd: string, args: string[], cb?: Function) => {
				spawned.push([cmd, ...args]);
				cb?.(null);
				return undefined as any;
			}) as any);

			const event = agentEndEvent([userMsg("test")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			expect(spawned.find((s) => s[0] === "osascript")).toBeDefined();
			expect(spawned.filter((s) => s[0] === "notify-send")).toHaveLength(0);
		});
	});

	// ===================================================================
	// Focus Tracking
	// ===================================================================
	describe("focus tracking", () => {
		it("suppresses notification when terminal remains focused", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			// Do NOT simulateFocusOut() — leave isFocused = true (default)

			stdoutWrite.mockClear();
			const event = agentEndEvent([userMsg("test")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			// Should be silent
			expect(stdoutWrite).not.toHaveBeenCalledWith(expect.stringContaining("\x1b]777"));
		});

		it("suppresses notification when terminal loses and regains focus", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			simulateFocusIn();

			stdoutWrite.mockClear();
			const event = agentEndEvent([userMsg("test")]);
			await pi.handlers.agent_end!(event, tuiCtx());

			// Should be silent
			expect(stdoutWrite).not.toHaveBeenCalledWith(expect.stringContaining("\x1b]777"));
		});


		it("cleans up stdin listener on session_shutdown", async () => {
			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			expect(stdinListeners.has("data")).toBe(true);
			const listener = stdinListeners.get("data");

			await pi.handlers.session_shutdown!(undefined, tuiCtx());
			expect(stdinRemove).toHaveBeenCalledWith("data", listener);
			expect(stdinListeners.has("data")).toBe(false);

			// Should also write the code to disable tracking
			expect(stdoutWrite).toHaveBeenCalledWith("\x1b[?1004l");
		});

		it("skips focus setup/cleanup in non-TUI modes", async () => {
			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			const ctx = nonTuiCtx("rpc");
			await pi.handlers.session_start!(undefined, ctx);
			expect(stdinListeners.has("data")).toBe(false);
			expect(stdoutWrite).not.toHaveBeenCalledWith("\x1b[?1004h");

			await pi.handlers.session_shutdown!(undefined, ctx);
			expect(stdoutWrite).not.toHaveBeenCalledWith("\x1b[?1004l");
		});
	});

	describe("tool_call", () => {
		it("notifies when ask_user_question is called", async () => {
			delete process.env.WT_SESSION;
			delete process.env.KITTY_WINDOW_ID;

			const pi = createMockPi();
			const factory = await loadNotify({ notifySend: true });
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = {
				toolName: "ask_user_question",
				input: { question: "Are you sure?" },
			};
			await pi.handlers.tool_call!(event, tuiCtx());

			expect(stdoutWrite).toHaveBeenCalledWith(
				expect.stringContaining(`\x1b]777;notify;Pi — Question;Question: "Are you sure?"\x07`),
			);
		});

		it("ignores other tools", async () => {
			const pi = createMockPi();
			const factory = await loadNotify();
			await factory(pi as any);

			await pi.handlers.session_start!(undefined, tuiCtx());
			simulateFocusOut();
			stdoutWrite.mockClear();

			const event = {
				toolName: "bash",
				input: { command: "ls" },
			};
			await pi.handlers.tool_call!(event, tuiCtx());

			expect(stdoutWrite).not.toHaveBeenCalled();
		});
	});
});
