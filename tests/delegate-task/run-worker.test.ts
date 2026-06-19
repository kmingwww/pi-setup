import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractResult,
  runWorker,
  runWorkerAsync,
} from "../../extensions/delegate-task/run-worker";
import { AgentManager } from "../../extensions/delegate-task/agent-manager";
import fs from "fs/promises";
import os from "os";

// ── Shared mocks ──
vi.mock("fs/promises");
vi.mock("os");
vi.mock("@earendil-works/pi-coding-agent", () => {
  class MockDefaultResourceLoader {
    async reload() {
      return;
    }
  }
  return {
    DefaultResourceLoader: MockDefaultResourceLoader,
    defineTool: vi.fn((def: unknown) => def),
    getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
    SessionManager: {
      create: vi.fn().mockReturnValue({}),
    },
    createAgentSession: vi.fn().mockResolvedValue({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: {
          state: {
            messages: [
              { role: "assistant", content: [{ type: "text", text: "Final result text" }] },
            ],
          },
        },
      },
    }),
  };
});

function setupMocks() {
  vi.spyOn(os, "homedir").mockReturnValue("/home/user");
  vi.spyOn(os, "tmpdir").mockReturnValue("/tmp");
  vi.spyOn(fs, "mkdir").mockResolvedValue(undefined);
  vi.spyOn(fs, "readFile").mockResolvedValue('---\ntools: ["read"]\n---\nmock body');
  vi.spyOn(fs, "access").mockResolvedValue(undefined);
  vi.spyOn(process, "cwd").mockReturnValue("/project");
}

/** Re-apply the default createAgentSession mock after vi.resetAllMocks clears it. */
async function setupSessionMock(messages?: unknown[]) {
  const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
  const msg = messages ?? [
    { role: "assistant", content: [{ type: "text", text: "Final result text" }] },
  ];
  vi.mocked(createAgentSession).mockResolvedValue({
    session: {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      agent: { state: { messages: msg } },
    },
  } as any);
}

// ── runWorker (sync) ──
describe("runWorker", () => {
  let manager: AgentManager;

  beforeEach(async () => {
    vi.resetAllMocks();
    manager = new AgentManager();
    setupMocks();
    await setupSessionMock();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("spawns a child agent, runs task, and returns result", async () => {
    const mainSessionId = "main-session-123";
    const result = await runWorker("do some research", "researcher", mainSessionId, manager);

    expect(result).toBe("Final result text");
    expect(manager.getActiveCount()).toBe(0);

    const status = await manager.getAgentStatuses();
    expect(status).toContain("[IDLE] researcher");
  });

  it("returns fallback message if result cannot be extracted", async () => {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(createAgentSession).mockResolvedValueOnce({
      session: {
        prompt: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockReturnValue(() => {}),
        agent: { state: { messages: [] } },
      },
    } as any);

    const result = await runWorker("task", "coder", "main-123", manager);
    expect(result).toBe("Task completed, but no text output was generated.");
  });

  it("registers agent early so it is tracked even on failure", async () => {
    const registerSpy = vi.spyOn(manager, "register");
    await runWorker("task", "coder", "main-123", manager);

    expect(registerSpy).toHaveBeenCalled();
    const calledArgs = registerSpy.mock.calls[0]!;
    expect(calledArgs[0]).toMatch(
      /^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(calledArgs[1]).toBe("coder");
    expect(calledArgs[2]).toBe("task");

    const agent = manager.agents.get(calledArgs[0]!);
    expect(agent?.session).toBeDefined();
  });

  it("targets an existing agent by ID when agentId is provided", async () => {
    const existingSession = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      agent: {
        state: {
          messages: [{ role: "assistant", content: [{ type: "text", text: "Reused result" }] }],
        },
      },
    } as any;

    manager.register("my-agent", "coder", "first task", undefined, existingSession);
    manager.markDone("my-agent", "done");

    const result = await runWorker("second task", "coder", "session-1", manager, "my-agent");

    expect(result).toBe("Reused result");
    expect(existingSession.prompt).toHaveBeenCalledWith("second task");

    const agents = Array.from(manager.agents.values()).filter((a) => a.agentType === "coder");
    expect(agents.length).toBe(1);
  });

  it("creates a new agent when targeting unknown agentId", async () => {
    const registerSpy = vi.spyOn(manager, "register");
    await runWorker("task", "coder", "session-1", manager, "nonexistent-id");

    expect(registerSpy).toHaveBeenCalled();
    const id = registerSpy.mock.calls[0]![0];
    expect(id).toBeTypeOf("string");
    expect(id).not.toBe("nonexistent-id");
  });

  it("stays idle after completion for future reuse", async () => {
    await runWorker("task", "researcher", "session-1", manager);

    const agents = Array.from(manager.agents.values());
    expect(agents.length).toBe(1);
    expect(agents[0]?.status).toBe("idle");
    expect(agents[0]?.session).toBeDefined();
  });

  it("fires onUpdate with tool log entries when reusing an existing agent by agentId", async () => {
    // RED: This test fails because the reuse path never wires onUpdate
    let subscribeCallback: ((event: any) => void) | null = null;

    const existingSession = {
      prompt: vi.fn().mockImplementation(async () => {
        // Simulate what real tool execution emits
        if (subscribeCallback) {
          subscribeCallback({
            type: "tool_execution_start",
            toolName: "read",
            args: { path: "/test.txt" },
          });
          subscribeCallback({
            type: "tool_execution_end",
            toolName: "read",
            args: { path: "/test.txt" },
            isError: false,
          });
        }
      }),
      subscribe: vi.fn().mockImplementation((cb: (event: any) => void) => {
        subscribeCallback = cb;
        return () => {};
      }),
      agent: {
        state: {
          messages: [{ role: "assistant", content: [{ type: "text", text: "Reused result" }] }],
        },
      },
    } as any;

    manager.register("my-agent", "coder", "first task", undefined, existingSession);
    manager.markDone("my-agent", "done");

    const onUpdate = vi.fn();
    await runWorker("second task", "coder", "session-1", manager, "my-agent", undefined, onUpdate);

    // onUpdate should have been called at least once with tool-log entries
    expect(onUpdate).toHaveBeenCalled();

    // The last call should have a completed (done) tool entry for "read"
    const calls = onUpdate.mock.calls;
    const lastArgs = calls[calls.length - 1]?.[0] as any[];
    expect(lastArgs).toBeInstanceOf(Array);
    expect(lastArgs.length).toBeGreaterThan(0);
    const toolEntry = lastArgs.find((e: any) => e.label?.startsWith("read "));
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.status).toBe("done");
  });
});

// ── runWorkerAsync (fire-and-forget) ──
describe("runWorkerAsync", () => {
  let manager: AgentManager;

  beforeEach(async () => {
    vi.resetAllMocks();
    manager = new AgentManager();
    setupMocks();
    await setupSessionMock();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("routes success to mainNotify when caller is main", async () => {
    manager.mainNotify = vi.fn().mockResolvedValue(undefined);

    let notifyResolve: () => void;
    const notifyCalled = new Promise<void>((resolve) => {
      notifyResolve = resolve;
    });
    manager.mainNotify = vi.fn().mockImplementation(async () => {
      notifyResolve();
    });

    runWorkerAsync("do some research", "researcher", "main-session-123", manager, "main");
    await notifyCalled;

    expect(manager.mainNotify).toHaveBeenCalledTimes(1);
    const msg = manager.mainNotify!.mock?.calls[0]?.[0] as string;
    expect(msg).toMatch(/^✅ researcher done:/);
    expect(msg).toContain("Final result text");
  });

  it("stores notification on headless agent record when caller is not main", async () => {
    manager.register("child-agent", "researcher", "first task");

    const notifyCalled = new Promise<void>((resolve) => {
      const check = () => {
        const n = manager.agents.get("child-agent")?.notifications;
        if (n && n.length > 0) resolve();
        else setTimeout(check, 1);
      };
      check();
    });

    runWorkerAsync("research", "researcher", "main-123", manager, "child-agent");
    await notifyCalled;

    const agent = manager.agents.get("child-agent")!;
    expect(agent.notifications.length).toBe(1);
    expect(agent.notifications[0]).toMatch(/^✅ researcher done:/);
    expect(agent.notifications[0]).toContain("Final result text");
  });

  it("catches errors and sends failure notification to main", async () => {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(createAgentSession).mockRejectedValueOnce(new Error("Network failure"));

    manager.mainNotify = vi.fn().mockResolvedValue(undefined);

    let notifyResolve: () => void;
    const notifyCalled = new Promise<void>((resolve) => {
      notifyResolve = resolve;
    });
    manager.mainNotify = vi.fn().mockImplementation(async () => {
      notifyResolve();
    });

    runWorkerAsync("research", "researcher", "main-123", manager, "main");
    await notifyCalled;

    expect(manager.mainNotify).toHaveBeenCalledTimes(1);
    const msg = manager.mainNotify!.mock?.calls[0]?.[0] as string;
    expect(msg).toMatch(/^❌ researcher failed:/);
    expect(msg).toContain("Network failure");
  });

  it("catches errors and stores failure on headless agent", async () => {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(createAgentSession).mockRejectedValueOnce(new Error("Network failure"));

    manager.register("child-agent", "researcher", "task");

    const notifyCalled = new Promise<void>((resolve) => {
      const check = () => {
        const n = manager.agents.get("child-agent")?.notifications;
        if (n && n.length > 0) resolve();
        else setTimeout(check, 1);
      };
      check();
    });

    runWorkerAsync("research", "researcher", "main-123", manager, "child-agent");
    await notifyCalled;

    expect(manager.agents.get("child-agent")!.notifications[0]).toMatch(/^❌ researcher failed:/);
    expect(manager.agents.get("child-agent")!.notifications[0]).toContain("Network failure");
  });

  it("marks agent as idle even when worker crashes", async () => {
    const { createAgentSession } = await import("@earendil-works/pi-coding-agent");
    vi.mocked(createAgentSession).mockRejectedValueOnce(new Error("Network failure"));

    manager.mainNotify = vi.fn().mockResolvedValue(undefined);

    let notifyResolve: () => void;
    const notifyCalled = new Promise<void>((resolve) => {
      notifyResolve = resolve;
    });
    manager.mainNotify = vi.fn().mockImplementation(async () => {
      notifyResolve();
    });

    runWorkerAsync("research", "researcher", "main-123", manager, "main");
    await notifyCalled;

    expect(manager.getActiveCount()).toBe(0);
    const status = await manager.getAgentStatuses();
    expect(status).toContain("[IDLE] researcher");
  });

  it("does not throw or propagate errors to the caller", () => {
    expect(() => {
      runWorkerAsync("research", "researcher", "main-123", manager, "main");
    }).not.toThrow();
  });
});

// ── extractResult ──
describe("extractResult", () => {
  it("returns string content when msg.content is a plain string", () => {
    const state = {
      messages: [{ role: "assistant", content: "Direct string result" }],
    };
    const result = extractResult(state as any);
    expect(result).toBe("Direct string result");
  });

  it("skips empty string content and falls back to default message", () => {
    const state = {
      messages: [{ role: "assistant", content: "" }],
    };
    const result = extractResult(state as any);
    expect(result).toBe("Task completed, but no text output was generated.");
  });

  it("skips whitespace-only string content and falls back to default message", () => {
    const state = {
      messages: [{ role: "assistant", content: "   \n  " }],
    };
    const result = extractResult(state as any);
    expect(result).toBe("Task completed, but no text output was generated.");
  });
});
