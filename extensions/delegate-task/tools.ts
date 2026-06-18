import { agentManager } from "./agent-manager";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runWorker, runWorkerAsync, type ToolLogEntry } from "./run-worker";
import { Text } from "@earendil-works/pi-tui";

/** Defines delegate_task and check_agent_statuses tools. See docs/delegate-task.md. */

export function createAgentTools(
  currentAgentId: string,
  followUp?: (text: string) => Promise<void>,
) {
  const delegateTool = defineTool({
    name: "delegate_task",
    label: "Delegate Task",
    description:
      "Delegate a sub-task to a specialized background agent. Use 'sync' to pause your own work and wait for the result.",
    parameters: Type.Object({
      agentType: Type.String({
        description: "The role of the agent to delegate to (e.g., 'researcher', 'coder').",
      }),
      task: Type.String({
        description:
          "Detailed, self-contained instructions. The background agent has no memory of your current conversation, so you MUST include all necessary context, file paths, and specific goals.",
      }),
      mode: Type.Union([Type.Literal("sync"), Type.Literal("async")]),
    }),
    execute: async (id, params, signal, onUpdate, ctx) => {
      // Validate depth early
      const parentDepth = agentManager.agents.get(currentAgentId)?.depth || 0;
      if (parentDepth >= 5) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Maximum delegation depth of 5 reached. Cannot delegate further.",
            },
          ],
          details: { agentType: params.agentType, tools: [] as ToolLogEntry[] },
        };
      }

      if (params.mode === "sync") {
        const mainSessionId = ctx.sessionManager.getSessionId();
        let tools: ToolLogEntry[] = [];
        const result = await runWorker(
          params.task,
          params.agentType,
          currentAgentId,
          mainSessionId,
          agentManager,
          (entries) => {
            tools = entries;
            if (onUpdate) {
              // Summary in content (plain-text fallback) + structured in details (colored renderResult)
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
        );
        return {
          content: [{ type: "text", text: result }],
          details: { agentType: params.agentType, tools },
        };
      } else {
        // Async mode: fire-and-forget
        if (!followUp) {
          return {
            content: [
              {
                type: "text",
                text: "Error: async mode requires a followUp callback (not available in nested agents).",
              },
            ],
            details: { agentType: params.agentType, tools: [] as ToolLogEntry[] },
          };
        }
        const mainSessionId = ctx.sessionManager.getSessionId();
        runWorkerAsync(
          params.task,
          params.agentType,
          currentAgentId,
          mainSessionId,
          agentManager,
          followUp,
        );
        return {
          content: [
            {
              type: "text",
              text: `Background task delegated to ${params.agentType}. You will be notified when it completes.`,
            },
          ],
          details: { agentType: params.agentType, tools: [] as ToolLogEntry[] },
        };
      }
    },
    renderCall: (args, theme) => {
      const {
        agentType = "?",
        task = "",
        mode = "sync",
      } = args as { agentType?: string; task?: string; mode?: string };
      const preview = task.length > 60 ? task.slice(0, 60) + "…" : task;

      let text =
        theme.fg("toolTitle", theme.bold("delegate ")) +
        theme.fg("accent", agentType) +
        theme.fg("muted", ` [${mode}]`);
      if (preview) {
        text += "\n  " + theme.fg("dim", preview);
      }
      return new Text(text, 0, 0);
    },
    renderResult: (result, options, theme) => {
      const details = result.details as { tools?: ToolLogEntry[]; agentType?: string } | undefined;
      const toolLog: ToolLogEntry[] = details?.tools || [];

      // Format a single tool entry with theme-colored status icon
      const formatEntry = (e: ToolLogEntry): string => {
        const icon =
          e.status === "done"
            ? theme.fg("success", "✓")
            : e.status === "error"
              ? theme.fg("error", "✗")
              : theme.fg("dim", "○");
        return theme.fg("dim", e.label) + " " + icon;
      };

      // During streaming: show agent type header + each tool on its own line
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

      // Final result: agent summary + first line of output
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
      if (preview) {
        display += "\n  " + theme.fg("dim", preview);
      }
      return new Text(display, 0, 0);
    },
  });

  const statusTool = defineTool({
    name: "check_agent_statuses",
    label: "Check Agent Statuses",
    description:
      "Check the status of all delegated background agents. Use this to see what the team is currently doing to avoid duplicating tasks.",
    parameters: Type.Object({}),
    execute: async () => {
      return {
        content: [{ type: "text", text: agentManager.getAgentStatuses(currentAgentId) }],
        details: {},
      };
    },
  });

  return [delegateTool, statusTool];
}
