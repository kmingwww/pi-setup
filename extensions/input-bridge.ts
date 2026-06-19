/**
 * Input Bridge — connects pi lifecycle events to the extension event bus.
 *
 * Translates tool_call events for tools that need user interaction
 * (like ask_user_question) into "user-input-needed" events on pi.events.
 * The notify extension listens for these and fires desktop notifications.
 *
 * This keeps notify.ts purely event-driven — it never knows about specific
 * tools. Any extension can emit "user-input-needed" to trigger a notification.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Truncate a question string for the notification body. */
function buildAskBody(question: string): string {
  const maxLen = 72;
  const truncated =
    question.length > maxLen ? question.slice(0, maxLen - 3).trimEnd() + "…" : question;
  return `Question: "${truncated}"`;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName === "ask_user_question") {
      const q = event.input.question;
      const questionStr = typeof q === "string" ? q : "Waiting for user input...";
      pi.events.emit("user-input-needed", {
        title: "Pi — Question",
        body: buildAskBody(questionStr),
      });
    }
  });
}
