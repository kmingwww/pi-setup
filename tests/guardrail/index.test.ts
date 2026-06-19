import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock .agentignore file reading
const mockedReadFileSync = vi.fn();
const mockedExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (p: string, _encoding: string) => mockedReadFileSync(p),
    existsSync: (p: string) => mockedExistsSync(p),
  },
  readFileSync: (p: string, _encoding: string) => mockedReadFileSync(p),
  existsSync: (p: string) => mockedExistsSync(p),
}));

import factory, { clearAgentIgnoreCache } from "../../extensions/guardrail/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockPi {
  on: ReturnType<typeof vi.fn>;
  handlers: Record<string, Function[]>;
  events: { on: ReturnType<typeof vi.fn>; emit: ReturnType<typeof vi.fn> };
  appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockPi {
  const handlers: Record<string, Function[]> = {};
  return {
    handlers,
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    }),
    events: {
      on: vi.fn(),
      emit: vi.fn(),
    },
    appendEntry: vi.fn(),
  };
}

interface MockCtx {
  hasUI: boolean;
  mode: string;
  cwd: string;
  ui: {
    select: ReturnType<typeof vi.fn>;
    notify: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setWidget: ReturnType<typeof vi.fn>;
    setTitle: ReturnType<typeof vi.fn>;
    setEditorText: ReturnType<typeof vi.fn>;
  };
}

function tuiCtx(overrides: Partial<MockCtx> = {}): MockCtx {
  return {
    hasUI: true,
    mode: "tui",
    cwd: "/home/user/proj",
    ui: {
      select: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setTitle: vi.fn(),
      setEditorText: vi.fn(),
    },
    ...overrides,
  };
}

function nonTuiCtx(overrides: Partial<MockCtx> = {}): MockCtx {
  return {
    hasUI: false,
    mode: "print",
    cwd: "/home/user/proj",
    ui: {
      select: vi.fn(),
      notify: vi.fn(),
      confirm: vi.fn(),
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      setTitle: vi.fn(),
      setEditorText: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("guardrail extension registration", () => {
  it("registers one tool_call handler + session_start", async () => {
    const pi = createMockPi();
    factory(pi as any);

    expect(pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    // Only 1 tool_call handler (unified) + 1 session_start = 2
    expect(pi.handlers["tool_call"]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bash guardrail
// ---------------------------------------------------------------------------

describe("bash guardrail", () => {
  beforeEach(() => {
    clearAgentIgnoreCache();
    mockedExistsSync.mockReturnValue(false);
    mockedReadFileSync.mockReturnValue("");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function getHandler(): Promise<Function> {
    const pi = createMockPi();
    factory(pi as any);
    return pi.handlers["tool_call"]![0]!;
  }

  describe("dangerous commands (elevated tier)", () => {
    it("prompts user and blocks when user says Block", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();
      ctx.ui.select.mockResolvedValue("Block");

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm -rf /tmp/foo" },
      };

      const result = await handler(event, ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("Dangerous command"), [
        "Block",
        "Allow",
      ]);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("Blocked by user"),
      });
    });

    it("allows the command when user selects Allow", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();
      ctx.ui.select.mockResolvedValue("Allow");

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm -rf /tmp/foo" },
      };

      const result = await handler(event, ctx);
      expect(ctx.ui.select).toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe("restricted commands (always blocked)", () => {
    it("blocks mkfs without prompting even in interactive mode", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "mkfs.ext4 /dev/sdb" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("Blocked"),
      });
      // No prompt for restricted commands
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });

    it("blocks fork bomb without prompting", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: ":(){ :|:& };:" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("Blocked"),
      });
    });
  });

  describe("protected path targeting via bash", () => {
    it("auto-blocks bash commands targeting .git/ (restricted tier)", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm .git/config" },
      };

      const result = await handler(event, ctx);
      // Restricted tier: auto-blocked, no interactive prompt
      expect(ctx.ui.select).not.toHaveBeenCalled();
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("targets protected path"),
      });
    });

    it("prompts when bash command targets .agentignore-protected path", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".env\n");

      const handler = await getHandler();
      const ctx = tuiCtx();
      ctx.ui.select.mockResolvedValue("Block");

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm .env" },
      };

      const result = await handler(event, ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("protected path"), [
        "Block",
        "Allow",
      ]);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("agentignore"),
      });
    });

    it("blocks in non-interactive mode when targeting protected paths", async () => {
      const handler = await getHandler();
      const ctx = nonTuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm .git/config" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("targets protected path"),
      });
    });
  });

  describe("safe commands", () => {
    it("passes through safe commands without prompting", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "ls -la" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
      expect(ctx.ui.select).not.toHaveBeenCalled();
    });
  });

  describe("non-interactive mode (hasUI = false)", () => {
    it("auto-blocks elevated commands without prompting", async () => {
      const handler = await getHandler();
      const ctx = nonTuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "sudo rm -rf /" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("no UI"),
      });
    });

    it("passes through safe commands", async () => {
      const handler = await getHandler();
      const ctx = nonTuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "git status" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Path guardrail (write/edit)
// ---------------------------------------------------------------------------

describe("path guardrail", () => {
  beforeEach(() => {
    clearAgentIgnoreCache();
    mockedExistsSync.mockReset();
    mockedReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function getHandler(): Promise<Function> {
    const pi = createMockPi();
    factory(pi as any);
    return pi.handlers["tool_call"]![0]!;
  }

  describe("write tool", () => {
    it("blocks writes to .git/ (restricted)", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/config" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("protected path"),
      });
    });

    it("blocks writes to .pi/ (restricted)", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.pi/settings.json" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("protected path"),
      });
    });

    it("allows writes to safe paths", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/src/foo.ts" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
    });
  });

  describe("edit tool", () => {
    it("blocks edits to .git/", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "edit",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/HEAD" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("protected path"),
      });
    });

    it("blocks edits to .pi/", async () => {
      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "edit",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.pi/settings.json" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("protected path"),
      });
    });
  });

  describe(".agentignore integration", () => {
    it("blocks writes matching .agentignore patterns", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".env\nsecrets/\n");

      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.env" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining(".agentignore"),
      });
    });

    it("allows files excluded by negation patterns", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".env\n.env.*\n!*.env.example\n");

      const handler = await getHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.env.example" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
    });

    it("caches .agentignore across invocations", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".env\n");

      const pi = createMockPi();
      factory(pi as any);
      const handler = pi.handlers["tool_call"]![0]!;
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.env" },
      };

      // First call — should read the file
      await handler(event, ctx);
      expect(mockedExistsSync).toHaveBeenCalled();

      // Second call — should use cache (no new fs calls)
      mockedExistsSync.mockClear();
      mockedReadFileSync.mockClear();
      await handler(event, ctx);
      expect(mockedExistsSync).not.toHaveBeenCalled();
    });
  });

  describe("non-interactive mode", () => {
    it("blocks protected paths in non-interactive mode", async () => {
      const handler = await getHandler();
      const ctx = nonTuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/config" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("protected path"),
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Read guardrail
// ---------------------------------------------------------------------------

describe("read guardrail", () => {
  beforeEach(() => {
    clearAgentIgnoreCache();
    mockedExistsSync.mockReset();
    mockedReadFileSync.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function getHandler(): Promise<Function> {
    const pi = createMockPi();
    factory(pi as any);
    return pi.handlers["tool_call"]![0]!;
  }

  it("prompts for read of protected .git/ path with Allow option", async () => {
    const handler = await getHandler();
    const ctx = tuiCtx();
    ctx.ui.select.mockResolvedValue("Allow");

    const event = {
      toolName: "read",
      toolCallId: "call_1",
      input: { path: "/home/user/proj/.git/config" },
    };

    const result = await handler(event, ctx);
    // Should not block if user allows
    expect(result).toBeUndefined();
    expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("Protected path"), [
      "Block",
      "Allow",
    ]);
  });

  it("blocks read of protected path when user selects Block", async () => {
    const handler = await getHandler();
    const ctx = tuiCtx();
    ctx.ui.select.mockResolvedValue("Block");

    const event = {
      toolName: "read",
      toolCallId: "call_1",
      input: { path: "/home/user/proj/.git/config" },
    };

    const result = await handler(event, ctx);
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("Blocked by user"),
    });
  });

  it("allows read of unprotected paths without prompting", async () => {
    const handler = await getHandler();
    const ctx = tuiCtx();

    const event = {
      toolName: "read",
      toolCallId: "call_1",
      input: { path: "/home/user/proj/src/foo.ts" },
    };

    const result = await handler(event, ctx);
    expect(result).toBeUndefined();
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });

  it("skips non-read/write/edit/bash tool calls", async () => {
    const handler = await getHandler();
    const ctx = tuiCtx();

    const event = {
      toolName: "unknown_tool",
      toolCallId: "call_1",
      input: { path: "/home/user/proj/.git/config" },
    };

    const result = await handler(event, ctx);
    expect(result).toBeUndefined();
  });

  it("returns undefined when path is missing from input", async () => {
    const handler = await getHandler();
    const ctx = tuiCtx();

    const event = {
      toolName: "write",
      toolCallId: "call_1",
      input: {} as { path?: string },
    };

    const result = await handler(event, ctx);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error boundary
// ---------------------------------------------------------------------------

describe("error boundary", () => {
  it("fails-safe by blocking if guardrail throws", async () => {
    // Suppress console.error from the guardrail's catch block
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const pi = createMockPi();
    factory(pi as any);
    const handler = pi.handlers["tool_call"]![0]!;

    // Mock a ctx that will throw when ui.select is called
    const ctx = tuiCtx();
    ctx.ui.select.mockRejectedValue(new Error("UI subsystem crash"));

    // Create a legit dangerous bash command event
    const event = {
      toolName: "bash",
      toolCallId: "call_1",
      input: { command: "rm -rf /tmp/foo" },
    };

    const result = await handler(event, ctx);
    // Should fail safe by blocking
    expect(result).toEqual({
      block: true,
      reason: expect.stringContaining("Guardrail"),
    });

    // Verify the error was logged
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
