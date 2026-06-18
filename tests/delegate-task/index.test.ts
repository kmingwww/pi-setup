import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi } from "vitest";
import delegateTaskPlugin from "../../extensions/delegate-task/index";
import { agentManager } from "../../extensions/delegate-task/agent-manager";

describe("delegate-task", () => {
  it("registers delegate_task and check_agent_statuses tools", async () => {
    const mockPi = {
      registerTool: vi.fn(),
      sendUserMessage: vi.fn().mockResolvedValue(undefined),
    };

    await delegateTaskPlugin(mockPi as unknown as ExtensionAPI);

    expect(mockPi.registerTool).toHaveBeenCalledTimes(2);

    const args1 = mockPi.registerTool.mock.calls[0]![0]!;
    const args2 = mockPi.registerTool.mock.calls[1]![0]!;

    const names = [args1.name, args2.name];
    expect(names).toContain("delegate_task");
    expect(names).toContain("check_agent_statuses");
  });

  it("registers root agent in the manager", async () => {
    const mockPi = {
      registerTool: vi.fn(),
      sendUserMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as ExtensionAPI;

    await delegateTaskPlugin(mockPi);

    expect(agentManager.agents.has("root")).toBe(true);
    expect(agentManager.agents.get("root")?.status).toBe("running");
  });
});
