/**
 * Integration tests for delegate-task.
 *
 * Tests actual AgentSession creation (via createAgentSession + mock LLM) and
 * agent-to-agent communication through runWorker / runWorkerAsync.
 *
 * Two levels of integration:
 *   1. Real AgentSession reuse — runWorker delegates to a real session with mock LLM.
 *   2. Tool-level integration — delegate_task tool execute() with Context wired through.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";

import {
  AuthStorage,
  ModelRegistry,
  createAgentSession,
  SessionManager,
  DefaultResourceLoader,
  getAgentDir,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { agentManager, AgentManager } from "../../extensions/delegate-task/agent-manager";
import { runWorker, runWorkerAsync } from "../../extensions/delegate-task/run-worker";
import { createAgentTools } from "../../extensions/delegate-task/tools";

// ---------------------------------------------------------------------------
// Minimal mock AssistantMessageEventStream
// ---------------------------------------------------------------------------

/**
 * A minimal duck-type-compatible replacement for
 * `AssistantMessageEventStream` from `@earendil-works/pi-ai`.
 *
 * AgentSession consumes this via `for await (const event of stream)`, so we
 * only need: async iterable, `push(event)`, `end(result?)`, and `result()`.
 */
class MockEventStream {
  private events: unknown[] = [];
  private _ended = false;
  private _endResult: unknown = undefined;
  private _resolveResult!: (value: unknown) => void;
  private _resultPromise = new Promise<unknown>((resolve) => {
    this._resolveResult = resolve;
  });
  private _waiting: ((result: IteratorResult<unknown>) => void) | undefined = undefined;

  push(event: unknown): void {
    if (this._waiting) {
      const w = this._waiting;
      this._waiting = undefined;
      w({ value: event, done: false });
    } else {
      this.events.push(event);
    }
  }

  end(result?: unknown): void {
    this._ended = true;
    this._endResult = result;
    this._resolveResult(result);
    // If consumer is waiting, unblock it with done
    if (this._waiting) {
      const w = this._waiting;
      this._waiting = undefined;
      w({ value: undefined, done: true });
    }
  }

  result(): Promise<unknown> {
    return this._resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      async next(): Promise<IteratorResult<unknown>> {
        if (self.events.length > 0) {
          return { value: self.events.shift()!, done: false };
        }
        if (self._ended) {
          return { value: undefined, done: true };
        }
        return new Promise<IteratorResult<unknown>>((resolve) => {
          self._waiting = resolve;
        });
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Mock LLM helpers
// ---------------------------------------------------------------------------

const MOCK_MODEL_ID = "mock-1";
const MOCK_PROVIDER = "mock";

function mockReply(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "mock-api",
    provider: MOCK_PROVIDER,
    model: MOCK_MODEL_ID,
    usage: {
      input: 20,
      output: text.length,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 20 + text.length,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Create a streamSimple handler that emits a single canned text response.
 *
 * Works without importing from @earendil-works/pi-ai — uses a minimal
 * duck-type-compatible EventStream implementation instead.
 */
function makeStreamHandler(replyText: string) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  return (_model: unknown, _context: unknown, _options: unknown) => {
    const stream = new MockEventStream();
    const final = mockReply(replyText);

    // Emit events asynchronously (mimics real streaming)
    queueMicrotask(() => {
      stream.push({ type: "start", partial: { ...final, content: [] } });
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...final, content: [{ type: "text", text: "" }] },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: replyText,
        partial: { ...final, content: [{ type: "text", text: replyText }] },
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: replyText,
        partial: { ...final, content: [{ type: "text", text: replyText }] },
      });
      stream.end(final);
    });

    return stream;
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

interface MockSessionFixture {
  session: Awaited<ReturnType<typeof createAgentSession>>["session"];
  modelRegistry: ModelRegistry;
  authStorage: AuthStorage;
  setReply: (text: string) => void;
  dispose: () => void;
}

async function createMockSession(cwd?: string): Promise<MockSessionFixture> {
  const testCwd = cwd ?? process.cwd();
  const agentDir = getAgentDir();

  const authStorage = AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(MOCK_PROVIDER, "test-api-key");

  const modelRegistry = ModelRegistry.inMemory(authStorage);

  function registerProvider(replyText: string) {
    modelRegistry.registerProvider(MOCK_PROVIDER, {
      name: "Mock Provider",
      baseUrl: "http://localhost:0",
      apiKey: "test-api-key",
      api: "anthropic-messages" as any,
      models: [
        {
          id: MOCK_MODEL_ID,
          name: "Mock Model 1",
          reasoning: false,
          input: ["text"] as any,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
      ],
      streamSimple: makeStreamHandler(replyText) as any,
    });
  }

  registerProvider("Default mock response.");

  const loader = new DefaultResourceLoader({
    cwd: testCwd,
    agentDir,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "You are a test agent.",
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: testCwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(testCwd),
    tools: [],
  });

  const mockModel = modelRegistry.find(MOCK_PROVIDER, MOCK_MODEL_ID);
  if (mockModel) {
    await session.setModel(mockModel);
  }

  return {
    session,
    modelRegistry,
    authStorage,
    setReply: (text: string) => {
      registerProvider(text);
    },
    dispose: () => {
      session.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("delegate-task integration", () => {
  let manager: AgentManager;

  beforeEach(() => {
    agentManager.agents.clear();
    manager = agentManager;
  });

  afterEach(() => {
    manager.disposeAll();
  });

  describe("runWorker with real AgentSession (reuse path)", () => {
    it("delegates a task to an existing real session and returns the extracted result", async () => {
      const fixture = await createMockSession();
      fixture.setReply("I found 42 results in the database.");

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "researcher", "initial task", undefined, fixture.session);
      manager.markDone(agentId, "previous result");

      const result = await runWorker(
        "search for pi",
        "researcher",
        "main-session-1",
        manager,
        agentId,
      );

      expect(result).toBe("I found 42 results in the database.");
      expect(manager.getActiveCount()).toBe(0);

      const agent = manager.agents.get(agentId);
      expect(agent?.status).toBe("idle");
      expect(agent?.result).toBe("I found 42 results in the database.");

      fixture.dispose();
    });

    it("preserves accumulated context across multiple tasks on the same session", async () => {
      const fixture = await createMockSession();

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "coder", "first task", undefined, fixture.session);
      manager.markDone(agentId, "done 1");

      fixture.setReply("fixed lint error in utils.ts");
      const result1 = await runWorker(
        "fix lint error in utils.ts",
        "coder",
        "main-session-1",
        manager,
        agentId,
      );
      expect(result1).toBe("fixed lint error in utils.ts");

      fixture.setReply("added test for utils.ts fix");
      const result2 = await runWorker(
        "add a test for that fix",
        "coder",
        "main-session-1",
        manager,
        agentId,
      );
      expect(result2).toBe("added test for utils.ts fix");

      expect(manager.agents.size).toBe(1);

      fixture.dispose();
    });

    it("fires onUpdate with tool-log entries from real session events", async () => {
      const fixture = await createMockSession();
      fixture.setReply("Task done.");

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "worker", "first task", undefined, fixture.session);
      manager.markDone(agentId, "done");

      const onUpdate = vi.fn();
      await runWorker("do work", "worker", "main-session-1", manager, agentId, undefined, onUpdate);

      expect(onUpdate).toHaveBeenCalled();

      fixture.dispose();
    });

    it("marks agent as idle even when session.prompt throws", async () => {
      const badSession = {
        prompt: vi.fn().mockRejectedValue(new Error("LLM timeout")),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: { state: { messages: [] } },
        dispose: vi.fn(),
      } as any;

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "coder", "first task", undefined, badSession);
      manager.markDone(agentId, "done");

      await expect(runWorker("do work", "coder", "main-1", manager, agentId)).rejects.toThrow(
        "LLM timeout",
      );

      const agent = manager.agents.get(agentId);
      expect(agent?.status).toBe("idle");
    });
  });

  describe("runWorkerAsync with real AgentSession", () => {
    it("delivers success to main via adapter", async () => {
      const fixture = await createMockSession();
      fixture.setReply("Background research complete: found 7 papers.");

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "researcher", "initial task", undefined, fixture.session);
      manager.markDone(agentId, "done");

      const notifyPromise = new Promise<string>((resolve) => {
        manager.registerAdapter("main", {
          deliverMessage: async (msg: string) => {
            resolve(msg);
          },
        });
      });

      runWorkerAsync("research topic X", "researcher", "main-session-1", manager, "main", agentId);

      const msg = await notifyPromise;
      expect(msg).toContain("✅ researcher done:");
      expect(msg).toContain("Background research complete");

      fixture.dispose();
    });

    it("delivers to headless agent via session.sendUserMessage", async () => {
      const fixture = await createMockSession();
      fixture.setReply("Sub-task finished.");

      const workerId = `agent-${crypto.randomUUID()}`;
      manager.register(workerId, "worker", "initial task", undefined, fixture.session);
      manager.markDone(workerId, "done");

      // The caller is a headless agent with its own session
      const callerSession = fixture.session; // reuse the same session for simplicity
      const callerId = "child-agent-1";
      manager.register(callerId, "orchestrator", "orchestrating", undefined, callerSession);

      const notifyPromise = new Promise<string>((resolve) => {
        // Spy on sendUserMessage to capture delivery
        const original = callerSession.sendUserMessage.bind(callerSession);
        callerSession.sendUserMessage = vi
          .fn()
          .mockImplementation(async (msg: string, opts?: any) => {
            resolve(msg);
            return original(msg, opts);
          }) as any;
      });

      runWorkerAsync("sub task", "worker", "main-session-1", manager, callerId, workerId);

      const msg = await notifyPromise;
      expect(msg).toContain("✅ worker done:");
      expect(msg).toContain("Sub-task finished.");

      fixture.dispose();
    });

    it("delivers failure to main when worker crashes", async () => {
      const badSession = {
        prompt: vi.fn().mockRejectedValue(new Error("Connection refused")),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: { state: { messages: [] } },
        sendUserMessage: vi.fn(),
        dispose: vi.fn(),
      } as any;

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "worker", "initial", undefined, badSession);
      manager.markDone(agentId, "done");

      const notifyPromise = new Promise<string>((resolve) => {
        manager.registerAdapter("main", {
          deliverMessage: async (msg: string) => {
            resolve(msg);
          },
        });
      });

      runWorkerAsync("do work", "worker", "main-1", manager, "main", agentId);

      const msg = await notifyPromise;
      expect(msg).toContain("❌ worker failed:");
      expect(msg).toContain("Connection refused");
    });

    it("does not throw or propagate errors to caller", () => {
      expect(() => {
        runWorkerAsync("work", "worker", "main-1", manager, "main", "nonexistent");
      }).not.toThrow();
    });
  });

  describe("delegate_task tool (tool-level integration)", () => {
    it("sync mode executes through runWorker and returns result", async () => {
      const fixture = await createMockSession();
      fixture.setReply("Tool-level integration result.");

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "coder", "initial", undefined, fixture.session);
      manager.markDone(agentId, "done");

      const runWorkerModule = await import("../../extensions/delegate-task/run-worker");
      const runWorkerSpy = vi.spyOn(runWorkerModule, "runWorker");

      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task")!;

      const mockCtx: ExtensionContext = {
        sessionManager: { getSessionId: () => "tool-test-session-1" } as any,
        ui: {} as any,
        mode: "print",
        hasUI: false,
        cwd: process.cwd(),
        modelRegistry: fixture.modelRegistry,
        model: undefined,
        isIdle: () => true,
        isProjectTrusted: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
      };

      const result = await delegateTool.execute(
        "call-1",
        { agentType: "coder", task: "integrate module X", mode: "sync", agentId },
        undefined,
        undefined,
        mockCtx,
      );

      expect(runWorkerSpy).toHaveBeenCalledWith(
        "integrate module X",
        "coder",
        "tool-test-session-1",
        manager,
        agentId,
        undefined,
        expect.any(Function),
        "main", // replyTo
      );

      expect(result.content).toEqual([{ type: "text", text: "Tool-level integration result." }]);

      runWorkerSpy.mockRestore();
      fixture.dispose();
    });

    it("async mode calls runWorkerAsync and returns immediate acknowledgment", async () => {
      const fixture = await createMockSession();
      fixture.setReply("Async integration result.");

      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "researcher", "initial", undefined, fixture.session);
      manager.markDone(agentId, "done");

      const runWorkerModule = await import("../../extensions/delegate-task/run-worker");
      const runWorkerAsyncSpy = vi.spyOn(runWorkerModule, "runWorkerAsync");

      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task")!;

      const mockCtx: ExtensionContext = {
        sessionManager: { getSessionId: () => "tool-test-session-2" } as any,
        ui: {} as any,
        mode: "print",
        hasUI: false,
        cwd: process.cwd(),
        modelRegistry: fixture.modelRegistry,
        model: undefined,
        isIdle: () => true,
        isProjectTrusted: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
      };

      const result = await delegateTool.execute(
        "call-2",
        {
          agentType: "researcher",
          task: "find papers async",
          mode: "async",
          agentId,
        },
        undefined,
        undefined,
        mockCtx,
      );

      expect(runWorkerAsyncSpy).toHaveBeenCalledWith(
        "find papers async",
        "researcher",
        "tool-test-session-2",
        manager,
        "main",
        agentId,
        undefined,
      );

      expect((result.content[0] as any).text).toContain("Background task delegated");

      runWorkerAsyncSpy.mockRestore();
      fixture.dispose();
    });

    it("list_agents shows agent statuses from manager", async () => {
      const fixture = await createMockSession();
      const agentId = `agent-${crypto.randomUUID()}`;
      manager.register(agentId, "researcher", "doing math", undefined, fixture.session);

      const tools = createAgentTools("main");
      const statusTool = tools.find((t) => t.name === "list_agents")!;

      const result = await statusTool.execute(
        "call-3",
        {} as any,
        undefined,
        undefined,
        {} as ExtensionContext,
      );

      const text = result.content[0]!.text as string;
      expect(text).toContain("RUNNING AGENTS");
      expect(text).toContain("[RUNNING] researcher");
      expect(text).toContain(agentId);

      fixture.dispose();
    });
  });
});
