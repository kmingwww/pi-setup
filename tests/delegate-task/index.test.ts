import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi } from "vitest";
import { agentManager } from "../../extensions/delegate-task/agent-manager";
import delegateTaskPlugin from "../../extensions/delegate-task/index";

describe("delegate-task", () => {
  it("registers delegate_task and list_agents tools and adapter for main", async () => {
    const mockPi = {
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      sendUserMessage: vi.fn().mockResolvedValue(undefined),
    };

    agentManager.agents.clear();

    await delegateTaskPlugin(mockPi as unknown as ExtensionAPI);

    expect(mockPi.registerTool).toHaveBeenCalledTimes(2);

    const args1 = mockPi.registerTool.mock.calls[0]![0]!;
    const args2 = mockPi.registerTool.mock.calls[1]![0]!;

    const names = [args1.name, args2.name];
    expect(names).toContain("delegate_task");
    expect(names).toContain("list_agents");

    // Main should NOT be in the agents map (adapters are separate)
    expect(agentManager.agents.has("main")).toBe(false);

    // Deliver a message via the manager — the plugin registered an adapter
    // that forwards to pi.sendUserMessage
    await agentManager.deliverMessage("main", "test message");
    expect(mockPi.sendUserMessage).toHaveBeenCalledWith("test message", {
      deliverAs: "followUp",
    });
  });
});
