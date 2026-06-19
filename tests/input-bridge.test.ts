import { describe, it, expect, vi } from "vitest";

import factory from "../extensions/input-bridge";

// ---------------------------------------------------------------------------
// Minimal mock pi
// ---------------------------------------------------------------------------

function createMockPi() {
  const handlers: Record<string, Function> = {};
  const events = {
    emit: vi.fn(),
    on: vi.fn(),
  };
  return {
    handlers,
    on: vi.fn((event: string, handler: Function) => {
      handlers[event] = handler;
    }),
    events,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("input-bridge", () => {
  it("emits user-input-needed when ask_user_question is called", async () => {
    const pi = createMockPi();
    factory(pi as any);

    await pi.handlers.tool_call!({
      toolName: "ask_user_question",
      toolCallId: "call_1",
      input: { question: "Are you sure?" },
    });

    expect(pi.events.emit).toHaveBeenCalledWith("user-input-needed", {
      title: "Pi — Question",
      body: 'Question: "Are you sure?"',
    });
  });

  it("truncates long questions to 72 chars", async () => {
    const pi = createMockPi();
    factory(pi as any);

    const longQuestion =
      "This is a very long question that exceeds the maximum truncation length for questions";
    await pi.handlers.tool_call!({
      toolName: "ask_user_question",
      toolCallId: "call_1",
      input: { question: longQuestion },
    });

    const emitted = pi.events.emit.mock.calls[0] as [string, { title: string; body: string }];
    expect(emitted[1].body).not.toContain(longQuestion);
    expect(emitted[1].body).toMatch(/…"$/);
  });

  it("handles missing question gracefully", async () => {
    const pi = createMockPi();
    factory(pi as any);

    await pi.handlers.tool_call!({
      toolName: "ask_user_question",
      toolCallId: "call_1",
      input: {},
    });

    expect(pi.events.emit).toHaveBeenCalledWith("user-input-needed", {
      title: "Pi — Question",
      body: 'Question: "Waiting for user input..."',
    });
  });

  it("ignores other tools", async () => {
    const pi = createMockPi();
    factory(pi as any);

    await pi.handlers.tool_call!({
      toolName: "bash",
      toolCallId: "call_1",
      input: { command: "ls" },
    });

    expect(pi.events.emit).not.toHaveBeenCalled();
  });
});
