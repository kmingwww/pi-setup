import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  AgentManager,
  parseAgentFile,
  findAgentFile,
} from "../../extensions/delegate-task/agent-manager";
import fs from "fs/promises";
import os from "os";

vi.mock("fs/promises");
vi.mock("os");

describe("AgentManager", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/user");
    vi.spyOn(fs, "readdir").mockResolvedValue([]);
    manager = new AgentManager();
  });

  afterEach(() => {
    manager.destroy();
  });

  it("aborts all running sessions on abortAll", async () => {
    const mockSession1 = { abort: vi.fn().mockResolvedValue(undefined) } as any;
    const mockSession2 = { abort: vi.fn().mockResolvedValue(undefined) } as any;

    manager.register("id-1", "coder", "task 1", undefined, mockSession1);
    manager.register("id-2", "coder", "task 2", undefined, mockSession2);

    manager.markDone("id-2", "done");

    await manager.abortAll();

    expect(mockSession1.abort).toHaveBeenCalled();
    expect(mockSession2.abort).not.toHaveBeenCalled();
  });

  it("registers an agent", () => {
    manager.register("id-1", "coder", "do some work");
    const agent = manager.agents.get("id-1");
    expect(agent).toMatchObject({
      status: "running",
      agentType: "coder",
      currentTask: "do some work",
    });
  });

  it("marks an agent as idle and keeps the session reference", () => {
    const mockSession = { abort: vi.fn() } as any;
    manager.register("id-1", "coder", "task", undefined, mockSession);
    manager.markDone("id-1", "Success!");

    const agent = manager.agents.get("id-1");
    expect(agent?.status).toBe("idle");
    expect(agent?.result).toBe("Success!");
    // Session is kept alive for reuse
    expect(agent?.session).toBe(mockSession);
  });

  it("reports active agent count", () => {
    manager.register("id-1", "coder", "task 1");
    manager.register("id-2", "researcher", "task 2");
    manager.markDone("id-2", "done");

    expect(manager.getActiveCount()).toBe(1);
  });

  it("markRunning reassigns a task to an idle agent", () => {
    manager.register("id-1", "coder", "first task");
    manager.markDone("id-1", "done");
    manager.markRunning("id-1", "second task");

    const agent = manager.agents.get("id-1");
    expect(agent?.status).toBe("running");
    expect(agent?.currentTask).toBe("second task");
  });

  it("disposeAgent disposes session and removes agent", () => {
    const mockSession = { dispose: vi.fn() } as any;
    manager.register("id-1", "coder", "task", undefined, mockSession);

    manager.disposeAgent("id-1");

    expect(mockSession.dispose).toHaveBeenCalled();
    expect(manager.agents.has("id-1")).toBe(false);
  });

  it("disposeAll cleans up all agents", () => {
    const s1 = { dispose: vi.fn() } as any;
    const s2 = { dispose: vi.fn() } as any;
    manager.register("id-1", "coder", "t1", undefined, s1);
    manager.register("id-2", "coder", "t2", undefined, s2);

    manager.disposeAll();

    expect(s1.dispose).toHaveBeenCalled();
    expect(s2.dispose).toHaveBeenCalled();
    expect(manager.agents.size).toBe(0);
  });

  it("formats the team status as a flat list", async () => {
    manager.register("id-1", "manager", "coordinate team");
    manager.register("id-2", "researcher", "find docs");
    manager.markDone("id-2", "docs found");

    const status = await manager.getAgentStatuses();
    expect(status).toContain("RUNNING AGENTS:");
    expect(status).toContain("- [RUNNING] manager (id-1)");
    expect(status).toContain("Task: coordinate team");
    expect(status).toContain("- [IDLE] researcher (id-2)");
    expect(status).toContain("Last: docs found");
  });

  it("notifyAgent routes to mainNotify for main", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    manager.mainNotify = fn;

    await manager.notifyAgent("main", "hello");

    expect(fn).toHaveBeenCalledWith("hello");
  });

  it("notifyAgent stores on headless agent record", async () => {
    manager.register("agent-1", "researcher", "task");

    await manager.notifyAgent("agent-1", "result done");

    const agent = manager.agents.get("agent-1")!;
    expect(agent.notifications).toEqual(["result done"]);
  });

  it("getAgentStatuses shows and drains notifications for the caller", async () => {
    manager.register("agent-1", "researcher", "task");
    manager.agents.get("agent-1")!.notifications.push("✅ researcher done: found docs");

    const status = await manager.getAgentStatuses("agent-1");
    expect(status).toContain("PENDING RESULTS FROM DELEGATED TASKS:");
    expect(status).toContain("✅ researcher done: found docs");

    // Notifications are drained
    expect(manager.agents.get("agent-1")!.notifications).toEqual([]);
  });

  it("getAgentStatuses does not drain notifications for non-caller agents", async () => {
    manager.register("agent-1", "researcher", "task");
    manager.register("agent-2", "coder", "task");
    manager.agents.get("agent-1")!.notifications.push("secret");

    const status = await manager.getAgentStatuses("agent-2");
    expect(status).not.toContain("PENDING RESULTS");
    expect(manager.agents.get("agent-1")!.notifications).toEqual(["secret"]);
  });
});

describe("parseAgentFile", () => {
  it("extracts tools from frontmatter and returns the markdown body", () => {
    const content = `---
tools: ["read", "write"]
---
# Agent Context
You are a helpful assistant.`;

    const result = parseAgentFile(content);
    expect(result.tools).toEqual(["read", "write"]);
    expect(result.body).toBe("# Agent Context\nYou are a helpful assistant.");
  });

  it("returns undefined tools and the full body if no frontmatter is present", () => {
    const content = `# Agent Context\nYou are a helpful assistant.`;
    const result = parseAgentFile(content);
    expect(result.tools).toBeUndefined();
    expect(result.body).toBe("# Agent Context\nYou are a helpful assistant.");
  });
});

describe("findAgentFile", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("finds local legacy file first", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/user");
    vi.spyOn(process, "cwd").mockReturnValue("/project");

    vi.spyOn(fs, "access").mockImplementation(async (p) => {
      if (String(p).includes(".agent/agents/coder.md")) return undefined;
      throw new Error("Not found");
    });

    const result = await findAgentFile("coder");
    expect(result).toBe("/project/.agent/agents/coder.md");
  });

  it("falls back to local .pi path", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/user");
    vi.spyOn(process, "cwd").mockReturnValue("/project");

    vi.spyOn(fs, "access").mockImplementation(async (p) => {
      if (String(p).includes(".pi/agents/coder.md") && String(p).includes("/project"))
        return undefined;
      throw new Error("Not found");
    });

    const result = await findAgentFile("coder");
    expect(result).toBe("/project/.pi/agents/coder.md");
  });

  it("falls back to global .pi path", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/user");
    vi.spyOn(process, "cwd").mockReturnValue("/project");

    vi.spyOn(fs, "access").mockImplementation(async (p) => {
      if (String(p).includes("/home/user/.pi/agents/coder.md")) return undefined;
      throw new Error("Not found");
    });

    const result = await findAgentFile("coder");
    expect(result).toBe("/home/user/.pi/agents/coder.md");
  });

  it("returns null if no file is found", async () => {
    vi.spyOn(os, "homedir").mockReturnValue("/home/user");
    vi.spyOn(process, "cwd").mockReturnValue("/project");

    vi.spyOn(fs, "access").mockRejectedValue(new Error("Not found"));

    const result = await findAgentFile("coder");
    expect(result).toBeNull();
  });
});
