/** Registers delegate_task and list_agents tools, plus /list-agents TUI command. */
import { type ExtensionAPI, DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, SelectList, Text } from "@earendil-works/pi-tui";
import { agentManager, type AgentInfo } from "./agent-manager";
import { createAgentTools } from "./tools";

export default async function (pi: ExtensionAPI) {
  // Wire up main session notification for async task completion.
  agentManager.mainNotify = async (msg: string) => {
    pi.sendUserMessage(msg, { deliverAs: "followUp" });
  };

  const tools = createAgentTools("main");

  for (const tool of tools) {
    pi.registerTool(tool);
  }

  // ── /list-agents TUI command ──
  pi.registerCommand("list-agents", {
    description: "Show agent list in TUI overlay",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/list-agents requires TUI mode", "info");
        return;
      }

      const agents = agentManager.agents;
      if (agents.size === 0) {
        ctx.ui.notify("No agents running", "info");
        return;
      }

      const formatCost = (n: number): string => {
        if (n === 0) return "$0";
        if (n < 0.001) return `$${n.toFixed(6)}`;
        if (n < 1) return `$${n.toFixed(4)}`;
        return `$${n.toFixed(3)}`;
      };

      const formatTokens = (n: number): string => {
        if (n === 0) return "0";
        if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
        if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
        return String(n);
      };

      const tokenSummary = (t: AgentInfo["tokenUsage"]): string => {
        return (
          `↑${formatTokens(t.input)} ↓${formatTokens(t.output)}` +
          (t.cacheRead > 0 ? ` R${formatTokens(t.cacheRead)}` : "") +
          (t.cacheWrite > 0 ? ` W${formatTokens(t.cacheWrite)}` : "")
        );
      };

      const items = Array.from(agents.entries()).map(([id, info]) => {
        const costStr = formatCost(info.cost);
        const tokensStr = info.cost > 0 ? `  ${tokenSummary(info.tokenUsage)}` : "";
        const taskLine = info.currentTask
          ? `Task: ${info.currentTask.slice(0, 100)}`
          : info.result
            ? `Last: ${info.result.slice(0, 100)}`
            : "Idle";
        return {
          value: id,
          label: `[${info.status.toUpperCase()}] ${info.agentType}  ${costStr}`,
          description: taskLine + tokensStr,
        };
      });

      await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
        container.addChild(
          new Text(theme.fg("accent", theme.bold(`Agents (${items.length})`)), 1, 0),
        );

        const selectList = new SelectList(items, Math.min(items.length, 15), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • esc close"), 1, 0));
        container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

        return {
          render: (w) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    },
  });
}
