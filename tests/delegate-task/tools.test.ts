import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { agentManager } from "../../extensions/delegate-task/agent-manager";
import { createAgentTools } from "../../extensions/delegate-task/tools";
import * as runWorkerModule from "../../extensions/delegate-task/run-worker";

describe("createAgentTools", () => {
  beforeEach(() => {
    agentManager.agents.clear();
    // mock runWorker
    vi.spyOn(runWorkerModule, "runWorker").mockResolvedValue("Worker mock result");
    // mock runWorkerAsync (fire and forget) — calls deliverMessage
    vi.spyOn(runWorkerModule, "runWorkerAsync").mockImplementation(
      (_task, _agentType, _sessionId, manager, callerId, _agentId) => {
        void manager.deliverMessage(callerId, "✅ researcher done: Worker mock result");
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates tools including delegate_task and list_agents", () => {
    const tools = createAgentTools("main");
    expect(tools.length).toBe(2);
    expect(tools[0]!.name).toBe("delegate_task");
    expect(tools[1]!.name).toBe("list_agents");
  });

  it("delegate_task sync delegates to runWorker and returns result", async () => {
    const tools = createAgentTools("main");
    const delegateTool = tools.find((t) => t.name === "delegate_task");

    const mockCtx = {
      sessionManager: { getSessionId: () => "session-123" },
    } as unknown as ExtensionContext;

    const result = await delegateTool!.execute(
      "some-call-id",
      {
        agentType: "researcher",
        task: "find pi",
        mode: "sync",
      },
      undefined,
      undefined,
      mockCtx,
    );

    expect(runWorkerModule.runWorker).toHaveBeenCalledWith(
      "find pi",
      "researcher",
      "session-123",
      agentManager,
      undefined, // no agentId
      undefined, // no cwd
      expect.any(Function),
      "main", // replyTo
    );
    expect(result.content).toEqual([{ type: "text", text: "Worker mock result" }]);
    expect(result.details).toEqual({ agentType: "researcher", tools: [] });
  });

  it("delegate_task sync with agentId passes it to runWorker", async () => {
    const tools = createAgentTools("main");
    const delegateTool = tools.find((t) => t.name === "delegate_task");

    const mockCtx = {
      sessionManager: { getSessionId: () => "session-123" },
    } as unknown as ExtensionContext;

    await delegateTool!.execute(
      "call-id",
      {
        agentType: "coder",
        task: "fix bug",
        mode: "sync",
        agentId: "agent-existing-1",
      },
      undefined,
      undefined,
      mockCtx,
    );

    expect(runWorkerModule.runWorker).toHaveBeenCalledWith(
      "fix bug",
      "coder",
      "session-123",
      agentManager,
      "agent-existing-1",
      undefined, // no cwd
      expect.any(Function),
      "main", // replyTo
    );
  });

  it("list_agents shows agent statuses including idle and running", async () => {
    agentManager.register("agent-1", "researcher", "doing math");
    agentManager.register("agent-2", "coder", "writing tests");
    agentManager.markDone("agent-2", "done");

    const tools = createAgentTools("main");
    const statusTool = tools.find((t) => t.name === "list_agents")!;

    const result = await statusTool.execute(
      "some-call-id",
      {} as unknown as Record<string, unknown>,
      undefined,
      undefined,
      {} as unknown as ExtensionContext,
    );

    const text = result.content[0]!.text as string;
    expect(text).toContain("RUNNING AGENTS");
    expect(text).toContain("[RUNNING] researcher (agent-1)");
    expect(text).toContain("Task: doing math");
    expect(text).toContain("[IDLE] coder (agent-2)");
    expect(text).toContain("Last: done");
  });

  it("list_agents returns agent statuses from manager", async () => {
    agentManager.register("child-1", "researcher", "doing math");
    const tools = createAgentTools("main");
    const statusTool = tools.find((t) => t.name === "list_agents");

    const result = await statusTool!.execute(
      "some-call-id",
      {} as unknown as Record<string, unknown>,
      undefined,
      undefined,
      {} as unknown as ExtensionContext,
    );

    const expectedStatus = await agentManager.getAgentStatuses();
    expect(result).toEqual({ content: [{ type: "text", text: expectedStatus }], details: {} });
  });

  describe("renderCall", () => {
    const mockTheme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };

    it("handles undefined args without throwing and returns sensible defaults", () => {
      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      // Should not throw when called with undefined args
      let result: any;
      expect(() => {
        result = delegateTool!.renderCall(undefined, mockTheme as any);
      }).not.toThrow();

      // Should return a Text component with sensible defaults
      expect(result).toBeDefined();
      // The text should contain the default agent type "?"
      expect(result.text).toContain("?");
      // Should not contain agentId reference (since agentId is undefined)
      expect(result.text).not.toContain("→");
    });

    it("shows full agentId in renderCall output", () => {
      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const longId = "agent-550e8400-e29b-41d4-a716-446655440000";

      const result = delegateTool!.renderCall(
        { agentType: "coder", task: "fix bug", mode: "sync", agentId: longId },
        mockTheme as any,
      );

      // Extract the ID shown after the arrow
      const arrowMatch = result.text.match(/→\s+(\S+)/);
      expect(arrowMatch).not.toBeNull();
      const shownId = arrowMatch![1]!;
      // Should show the full agentId, not truncated
      expect(shownId).toBe(longId);
    });
  });

  describe("list_agents output", () => {
    it("shows full agent IDs in status output", async () => {
      const longId = "agent-550e8400-e29b-41d4-a716-446655440000";
      agentManager.register(longId, "researcher", "find docs");

      const tools = createAgentTools("main");
      const statusTool = tools.find((t) => t.name === "list_agents")!;

      const result = await statusTool.execute(
        "some-call-id",
        {} as unknown as Record<string, unknown>,
        undefined,
        undefined,
        {} as unknown as ExtensionContext,
      );

      const text = result.content[0]!.text as string;
      // Find the agent ID in parentheses after the agent type
      const match = text.match(/researcher\s+\(([^)]+)\)/);
      expect(match).not.toBeNull();
      const shownId = match![1]!;
      // Should show the full agentId, not truncated
      expect(shownId).toBe(longId);
    });
  });

  describe("async mode", () => {
    it("returns immediate acknowledgment for async mode", async () => {
      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const mockCtx = {
        sessionManager: { getSessionId: () => "session-123" },
      } as unknown as ExtensionContext;

      const result = await delegateTool!.execute(
        "some-call-id",
        {
          agentType: "researcher",
          task: "find pi docs asynchronously",
          mode: "async",
        },
        undefined,
        undefined,
        mockCtx,
      );

      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining("Background task delegated to researcher."),
        },
      ]);
      expect(result.details).toEqual({ agentType: "researcher", tools: [] });
    });

    it("calls runWorkerAsync with correct params for async mode", async () => {
      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const mockCtx = {
        sessionManager: { getSessionId: () => "session-123" },
      } as unknown as ExtensionContext;

      await delegateTool!.execute(
        "some-call-id",
        {
          agentType: "researcher",
          task: "find pi docs",
          mode: "async",
        },
        undefined,
        undefined,
        mockCtx,
      );

      expect(runWorkerModule.runWorkerAsync).toHaveBeenCalledWith(
        "find pi docs",
        "researcher",
        "session-123",
        agentManager,
        "main", // callerId
        undefined, // no agentId
        undefined, // no cwd
      );
    });

    it("async mode does not call runWorker (sync)", async () => {
      const tools = createAgentTools("main");
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const mockCtx = {
        sessionManager: { getSessionId: () => "session-123" },
      } as unknown as ExtensionContext;

      await delegateTool!.execute(
        "some-call-id",
        {
          agentType: "researcher",
          task: "find pi docs",
          mode: "async",
        },
        undefined,
        undefined,
        mockCtx,
      );

      expect(runWorkerModule.runWorker).not.toHaveBeenCalled();
    });
  });
});
