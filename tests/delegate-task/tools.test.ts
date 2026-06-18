import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { agentManager } from "../../extensions/delegate-task/agent-manager";
import { createAgentTools } from "../../extensions/delegate-task/tools";
import * as runWorkerModule from "../../extensions/delegate-task/run-worker";

describe("createAgentTools", () => {
  let followUp: any;

  beforeEach(() => {
    agentManager.agents.clear();
    followUp = vi.fn().mockResolvedValue(undefined);
    // mock runWorker
    vi.spyOn(runWorkerModule, "runWorker").mockResolvedValue("Worker mock result");
    // mock runWorkerAsync (fire and forget)
    vi.spyOn(runWorkerModule, "runWorkerAsync").mockImplementation(() => {
      // Simulates async execution: immediately calls followUp after microtask
      Promise.resolve().then(() => {
        followUp("✅ researcher done: Worker mock result");
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates tools including delegate_task and check_agent_statuses", () => {
    const tools = createAgentTools("main-agent", followUp);
    expect(tools.length).toBe(2);
    expect(tools[0]!.name).toBe("delegate_task");
    expect(tools[1]!.name).toBe("check_agent_statuses");
  });

  it("delegate_task sync delegates to runWorker and returns result", async () => {
    const tools = createAgentTools("main-agent", followUp);
    const delegateTool = tools.find((t) => t.name === "delegate_task");

    const mockCtx = {
      sessionManager: { getSessionId: () => "session-123" },
    } as any;

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
      "main-agent",
      "session-123",
      agentManager,
      expect.any(Function),
    );
    expect(result.content).toEqual([{ type: "text", text: "Worker mock result" }]);
    expect(result.details).toEqual({ agentType: "researcher", tools: [] });
  });

  it("check_agent_statuses returns agent statuses from manager", async () => {
    agentManager.register("child-1", "main-agent", "researcher", "doing math");
    const tools = createAgentTools("main-agent", followUp);
    const statusTool = tools.find((t) => t.name === "check_agent_statuses");

    const result = await statusTool!.execute(
      "some-call-id",
      {} as any,
      undefined,
      undefined,
      {} as any,
    );

    const expectedStatus = agentManager.getAgentStatuses("main-agent");
    expect(result).toEqual({ content: [{ type: "text", text: expectedStatus }], details: {} });
  });

  it("delegate_task rejects if depth >= 5", async () => {
    // Set up a deep hierarchy
    agentManager.register("agent-1", null, "t", "t");
    agentManager.register("agent-2", "agent-1", "t", "t");
    agentManager.register("agent-3", "agent-2", "t", "t");
    agentManager.register("agent-4", "agent-3", "t", "t");
    agentManager.register("agent-5", "agent-4", "t", "t"); // depth 5

    const tools = createAgentTools("agent-5", followUp);
    const delegateTool = tools.find((t) => t.name === "delegate_task");

    const result = await delegateTool!.execute(
      "some-call-id",
      {
        agentType: "researcher",
        task: "find pi",
        mode: "sync",
      },
      undefined,
      undefined,
      {} as any,
    );

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Error: Maximum delegation depth of 5 reached. Cannot delegate further.",
        },
      ],
      details: { agentType: "researcher", tools: [] },
    });
    expect(runWorkerModule.runWorker).not.toHaveBeenCalled();
  });

  describe("async mode", () => {
    it("returns immediate acknowledgment for async mode", async () => {
      const tools = createAgentTools("main-agent", followUp);
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const mockCtx = {
        sessionManager: { getSessionId: () => "session-123" },
      } as any;

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

      // Should return immediately with acknowledgment
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Background task delegated to researcher. You will be notified when it completes.",
        },
      ]);
      expect(result.details).toEqual({ agentType: "researcher", tools: [] });
    });

    it("calls runWorkerAsync with correct params for async mode", async () => {
      const tools = createAgentTools("main-agent", followUp);
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const mockCtx = {
        sessionManager: { getSessionId: () => "session-123" },
      } as any;

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
        "main-agent",
        "session-123",
        agentManager,
        followUp,
      );
    });

    it("does not call runWorker (sync) for async mode", async () => {
      const tools = createAgentTools("main-agent", followUp);
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const mockCtx = {
        sessionManager: { getSessionId: () => "session-123" },
      } as any;

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

      // runWorker (sync) should NOT be called for async mode
      expect(runWorkerModule.runWorker).not.toHaveBeenCalled();
    });

    it("rejects async mode if depth >= 5", async () => {
      agentManager.register("agent-1", null, "t", "t");
      agentManager.register("agent-2", "agent-1", "t", "t");
      agentManager.register("agent-3", "agent-2", "t", "t");
      agentManager.register("agent-4", "agent-3", "t", "t");
      agentManager.register("agent-5", "agent-4", "t", "t"); // depth 5

      const tools = createAgentTools("agent-5", followUp);
      const delegateTool = tools.find((t) => t.name === "delegate_task");

      const result = await delegateTool!.execute(
        "some-call-id",
        {
          agentType: "researcher",
          task: "find pi",
          mode: "async",
        },
        undefined,
        undefined,
        {} as any,
      );

      expect(result).toEqual({
        content: [
          {
            type: "text",
            text: "Error: Maximum delegation depth of 5 reached. Cannot delegate further.",
          },
        ],
        details: { agentType: "researcher", tools: [] },
      });
      expect(runWorkerModule.runWorkerAsync).not.toHaveBeenCalled();
    });
  });
});
