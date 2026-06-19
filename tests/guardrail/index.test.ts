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
  sessionManager: { getEntries: ReturnType<typeof vi.fn> };
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
    sessionManager: {
      getEntries: vi.fn(() => []),
    },
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
    custom: ReturnType<typeof vi.fn>;
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
      custom: vi.fn(),
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
      custom: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("guardrail extension registration", () => {
  it("registers two tool_call handlers", async () => {
    const pi = createMockPi();
    factory(pi as any);

    expect(pi.on).toHaveBeenCalledTimes(4);
    expect(pi.on).toHaveBeenCalledWith("tool_call", expect.any(Function));
    expect(pi.handlers["tool_call"]).toHaveLength(3);
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

  async function getBashHandler(): Promise<Function> {
    const pi = createMockPi();
    factory(pi as any);
    // Handler 1 is the bash guardrail (0=read, 1=bash, 2=path)
    return pi.handlers["tool_call"]![1]!;
  }

  describe("dangerous commands", () => {
    it("prompts user and blocks when user says Block", async () => {
      const handler = await getBashHandler();
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
      const handler = await getBashHandler();
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

  describe("protected path targeting via bash", () => {
    it("prompts when bash command targets .git/", async () => {
      const handler = await getBashHandler();
      const ctx = tuiCtx();
      ctx.ui.select.mockResolvedValue("Block");

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm .git/config" },
      };

      const result = await handler(event, ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("protected path"), [
        "Block",
        "Allow",
      ]);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("targets protected path"),
      });
    });

    it("prompts when bash command targets .agentignore-protected path", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".agentignore\n.env\n");

      const handler = await getBashHandler();
      const ctx = tuiCtx();
      ctx.ui.select.mockResolvedValue("Block");

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "rm .agentignore" },
      };

      const result = await handler(event, ctx);
      expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("protected path"), [
        "Block",
        "Allow",
      ]);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("targets protected path"),
      });
    });

    it("blocks in non-interactive mode when targeting protected paths", async () => {
      const handler = await getBashHandler();
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
      const handler = await getBashHandler();
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

    it("skips non-bash tool calls", async () => {
      const handler = await getBashHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "read",
        toolCallId: "call_1",
        input: { path: "/some/file" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
    });
  });

  describe("non-interactive mode (hasUI = false)", () => {
    async function getBashHandler(): Promise<Function> {
      const pi = createMockPi();
      factory(pi as any);
      return pi.handlers["tool_call"]![1]!;
    }

    it("auto-blocks dangerous commands without prompting", async () => {
      const handler = await getBashHandler();
      const ctx = nonTuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "sudo rm -rf /" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("dangerous command pattern"),
      });
    });

    it("passes through safe commands", async () => {
      const handler = await getBashHandler();
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
// Path guardrail
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

  async function getPathHandler(): Promise<Function> {
    const pi = createMockPi();
    factory(pi as any);
    // Handler 2 is the path guardrail (0=read, 1=bash, 2=path)
    return pi.handlers["tool_call"]![2]!;
  }

  describe("write tool", () => {
    it("blocks writes to .git/", async () => {
      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/config" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({ block: true, reason: "Path is protected" });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining(".git/config"), "warning");
    });

    it("blocks writes to .pi/", async () => {
      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.pi/settings.json" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({ block: true, reason: "Path is protected" });
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining(".pi/settings.json"),
        "warning",
      );
    });

    it("allows writes to safe paths", async () => {
      const handler = await getPathHandler();
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
      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "edit",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/HEAD" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({ block: true, reason: "Path is protected" });
    });

    it("blocks edits to .pi/", async () => {
      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "edit",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.pi/settings.json" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({ block: true, reason: "Path is protected" });
    });
  });

  describe(".agentignore integration", () => {
    it("blocks writes matching .agentignore patterns", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".env\nsecrets/\n");

      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.env" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({
        block: true,
        reason: "Path is protected by .agentignore",
      });
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("agentignore"), "warning");
    });

    it("allows files excluded by negation patterns", async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(".env\n.env.*\n!*.env.example\n");

      const handler = await getPathHandler();
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
      const handler = pi.handlers["tool_call"]![2]!; // 2 = path guardrail
      const ctx = tuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.env" },
      };

      // First call — should read the file
      await handler(event, ctx);
      expect(mockedExistsSync).toHaveBeenCalledTimes(1);
      expect(mockedReadFileSync).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      mockedExistsSync.mockClear();
      mockedReadFileSync.mockClear();
      await handler(event, ctx);
      expect(mockedExistsSync).not.toHaveBeenCalled();
    });
  });

  describe("non-interactive mode", () => {
    async function getPathHandler(): Promise<Function> {
      const pi = createMockPi();
      factory(pi as any);
      return pi.handlers["tool_call"]![2]!;
    }

    it("blocks protected paths in non-interactive mode", async () => {
      const handler = await getPathHandler();
      const ctx = nonTuiCtx();

      const event = {
        toolName: "write",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/config" },
      };

      const result = await handler(event, ctx);
      expect(result).toEqual({ block: true, reason: "Path is protected" });
    });
  });

  describe("skips non-write/edit tools", () => {
    it("skips read tool calls", async () => {
      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "read",
        toolCallId: "call_1",
        input: { path: "/home/user/proj/.git/config" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
    });

    it("skips bash tool calls", async () => {
      const handler = await getPathHandler();
      const ctx = tuiCtx();

      const event = {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "echo hello" },
      };

      const result = await handler(event, ctx);
      expect(result).toBeUndefined();
    });
  });

  describe("handles missing path gracefully", () => {
    it("returns undefined when path is missing from input", async () => {
      const handler = await getPathHandler();
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
});
