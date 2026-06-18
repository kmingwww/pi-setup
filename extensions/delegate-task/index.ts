/** Registers delegate_task and check_agent_statuses tools. See docs/delegate-task.md. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentTools } from "./tools";
import { agentManager } from "./agent-manager";

export default async function (pi: ExtensionAPI) {
  // Register the root session so depth tracking works for nested delegation.
  agentManager.register("root", null, "root", "Main agent session");

  // Create a followUp callback bound to the main session for async completion notifications.
  const followUp = async (text: string) => {
    pi.sendUserMessage(text, { deliverAs: "followUp" });
  };

  const tools = createAgentTools("root", followUp);

  for (const tool of tools) {
    pi.registerTool(tool);
  }
}
