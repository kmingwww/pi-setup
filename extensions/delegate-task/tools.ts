import { agentManager } from "./agent-manager";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runWorker, runWorkerAsync, type ToolLogEntry } from "./run-worker";
import { Text } from "@earendil-works/pi-tui";

/** Defines delegate_task and list_agents tools. */

export function createAgentTools(currentAgentId: string) {
  const delegateTool = defineTool({
    name: "delegate_task",
    label: "Delegate Task",
    description: [
      "Delegate a sub-task to a background agent (sync or async).",
      "",
      "sync — blocks, returns result directly. async — fires; result arrives as a",
      "  follow-up message automatically (no need to poll list_agents).",
      "",
      "agentId controls lifecycle:",
      "  Omit → spawn fresh agent (default). Use for new topics.",
      "  Provide → reuse existing idle agent by ID. Only when continuing its prior work.",
      "  Multiple agents of the same type on different topics is expected.",
      "  If unsure, spawn fresh. Extra agents are cheap; polluted context is expensive.",
      "",
      "agentType: role, maps to .pi/agents/{type}.md. Call list_agents to discover available types and IDs.",
      "cwd: optional working directory for the child agent's tools.",
      "task: include ALL context — the agent has its own isolated session.",
    ].join("\n"),
    promptSnippet: "Delegate sub-tasks to specialized background agents (sync/async, reusable).",
    promptGuidelines: [
      "Use delegate_task to offload work to a background agent while you focus on higher-level coordination.",
      "Prefer sync unless the task is truly independent and non-blocking.",
      "Spawn fresh (omit agentId) for new topics. Reuse by agentId only when continuing prior work.",
      "Include full file paths, code snippets, and specific goals in the task string.",
      "For async tasks the result arrives as a follow-up message automatically. Do not poll.",
      "Set cwd to make the agent operate in a different directory.",
    ],
    parameters: Type.Object({
      agentType: Type.String({
        description: [
          "Role, e.g. researcher, coder, reviewer.",
          "Maps to .pi/agents/{type}.md. Call list_agents to discover available types.",
          "Multiple agents can share a role on different topics.",
        ].join(" "),
      }),
      task: Type.String({
        description: [
          "Self-contained instructions. The agent has its own isolated session",
          "and does NOT see your conversation. Include all relevant context:",
          "file paths, code snippets, error messages, goals.",
        ].join(" "),
      }),
      mode: Type.Union([Type.Literal("sync"), Type.Literal("async")], {
        description: [
          "sync: blocks and returns the result directly.",
          "async: fire-and-forget. If you are the main session, the result",
          "arrives as a follow-up message — do not poll list_agents.",
        ].join(" "),
      }),
      agentId: Type.Optional(
        Type.String({
          description: [
            "Reuse an existing idle agent by ID (get from list_agents).",
            "Only reuse when continuing prior work. Omit to spawn fresh.",
          ].join(" "),
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: [
            "Working directory for the child agent.",
            "Tools (read, bash, edit, write) resolve relative to this path.",
            "Defaults to current directory.",
          ].join(" "),
        }),
      ),
    }),
    execute: async (_callId, params, _signal, onUpdate, ctx) => {
      const mainSessionId = ctx.sessionManager.getSessionId();

      if (params.mode === "sync") {
        let tools: ToolLogEntry[] = [];
        const result = await runWorker(
          params.task,
          params.agentType,
          mainSessionId,
          agentManager,
          params.agentId,
          params.cwd,
          (entries) => {
            tools = entries;
            if (onUpdate) {
              const summary =
                entries.length === 0
                  ? `[${params.agentType}] Starting…`
                  : entries
                      .map(
                        (e) =>
                          `${e.label} ${e.status === "done" ? "✓" : e.status === "error" ? "✗" : "○"}`,
                      )
                      .join(" · ");
              onUpdate({
                content: [{ type: "text", text: summary }],
                details: { tools, agentType: params.agentType },
              });
            }
          },
          currentAgentId, // replyTo — when this agent is re-invoked, report to who delegated it
        );
        return {
          content: [{ type: "text", text: result }],
          details: { agentType: params.agentType, tools },
        };
      } else {
        runWorkerAsync(
          params.task,
          params.agentType,
          mainSessionId,
          agentManager,
          currentAgentId,
          params.agentId,
          params.cwd,
        );
        const target = params.agentId ? ` (${params.agentId})` : "";
        return {
          content: [
            {
              type: "text",
              text: `Background task delegated to ${params.agentType}${target}. The result will arrive as a follow-up message automatically — no need to poll list_agents.`,
            },
          ],
          details: { agentType: params.agentType, tools: [] as ToolLogEntry[] },
        };
      }
    },
    renderCall: (args, theme) => {
      const safe = (args ?? {}) as Record<string, unknown>;
      const agentType = typeof safe.agentType === "string" ? safe.agentType : "?";
      const task = typeof safe.task === "string" ? safe.task : "";
      const mode = typeof safe.mode === "string" ? safe.mode : "sync";
      const agentId = typeof safe.agentId === "string" ? safe.agentId : undefined;
      const preview = task.length > 60 ? task.slice(0, 60) + "…" : task;
      const reuse = agentId ? ` → ${agentId}` : "";

      let text =
        theme.fg("toolTitle", theme.bold("delegate ")) +
        theme.fg("accent", agentType) +
        theme.fg("muted", ` [${mode}]${reuse}`);
      if (preview) text += "\n  " + theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },
    renderResult: (result, options, theme) => {
      const details = result.details as { tools?: ToolLogEntry[]; agentType?: string } | undefined;
      const toolLog: ToolLogEntry[] = details?.tools || [];

      const formatEntry = (e: ToolLogEntry): string => {
        const icon =
          e.status === "done"
            ? theme.fg("success", "✓")
            : e.status === "error"
              ? theme.fg("error", "✗")
              : theme.fg("dim", "○");
        return theme.fg("dim", e.label) + " " + icon;
      };

      if (options.isPartial) {
        if (toolLog.length === 0) {
          const fallback =
            result.content[0]?.type === "text" ? result.content[0].text : "Starting…";
          return new Text(theme.fg("dim", fallback));
        }
        const agentType = details?.agentType || "agent";
        const header =
          theme.fg("dim", `[${agentType}] `) +
          theme.fg("muted", `${toolLog.length} tool${toolLog.length !== 1 ? "s" : ""}`);
        return new Text(header + "\n" + toolLog.map(formatEntry).join("\n"), 0, 0);
      }

      const agentType = details?.agentType || "agent";
      const output = result.content[0]?.type === "text" ? result.content[0].text : "";
      const firstLine = output.split("\n")[0]?.trim() || "";
      const preview = firstLine.length > 70 ? firstLine.slice(0, 67) + "…" : firstLine;

      const toolSummary =
        toolLog.length > 0
          ? theme.fg("muted", ` · ${toolLog.length} tool${toolLog.length !== 1 ? "s" : ""}`)
          : "";

      let display =
        theme.fg("success", "✓ ") +
        theme.fg("toolTitle", theme.bold(agentType)) +
        theme.fg("muted", " done") +
        toolSummary;
      if (preview) display += "\n  " + theme.fg("dim", preview);
      return new Text(display, 0, 0);
    },
  });

  const statusTool = defineTool({
    name: "list_agents",
    label: "List Agents",
    description: [
      "List agents with status (RUNNING/IDLE), type, and ID.",
      "Also lists available agent types you can use with delegate_task.",
      "Use returned IDs as agentId in delegate_task to reuse an agent.",
    ].join(" "),
    promptSnippet: "List running agents and discover available agent types for delegate_task.",
    promptGuidelines: [
      "Call list_agents before your first delegate_task to discover available agent types and IDs.",
      "Do not call list_agents repeatedly between steps — you already know the IDs and types.",
      "For async tasks the result arrives as a follow-up message. Do not poll list_agents.",
      "Only check list_agents after async if a headless agent is waiting for results.",
      "Idle agents retain accumulated context — only reuse when continuing prior work.",
      "Available agent types are listed under AVAILABLE TYPES — use them as agentType in delegate_task.",
    ],
    parameters: Type.Object({}),
    execute: async () => {
      return {
        content: [{ type: "text", text: await agentManager.getAgentStatuses(currentAgentId) }],
        details: {},
      };
    },
  });

  return [delegateTool, statusTool];
}
