/**
 * Pi Notify Extension
 *
 * Sends a notification when Pi agent finishes a turn and is waiting for input.
 * Useful when you switch away from the Pi terminal and want to know when it's done.
 *
 * See docs/notify.md for documentation.
 *
 * Probes the system at load time and only uses notification mechanisms that are
 * actually available. Supports:
 * - Desktop notifications via `notify-send` (Linux) or `osascript` (macOS)
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Probe what's available on this system (runs once at extension load)
// ---------------------------------------------------------------------------

function probeBin(name: string): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("which", [name], (err) => resolve(!err));
	});
}

interface NotificationBackends {
	linux: boolean;       // notify-send (Linux)
	macos: boolean;       // osascript display notification (macOS)
	osc777: boolean;      // OSC 777 terminal escape (default)
	osc99: boolean;       // OSC 99 terminal escape (Kitty)
	windowsToast: boolean; // Windows Toast (WSL)
}

const backends: NotificationBackends = {
	linux: false,
	macos: false,
	osc777: false,
	osc99: false,
	windowsToast: false,
};

// ---------------------------------------------------------------------------
// Context extraction from agent messages
// ---------------------------------------------------------------------------

/** Walk messages in reverse to find the last user prompt. */
function extractPrompt(messages: any[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]!;
		if (msg.role !== "user" || !msg.content) continue;

		const content = msg.content;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			const text = content
				.filter((b: any) => b.type === "text")
				.map((b: any) => b.text)
				.join(" ");
			if (text) return text;
		}
	}
	return undefined;
}

/** Build the notification body, including a truncated quote of the user's prompt. */
function buildBody(prompt: string | undefined): string {
	if (!prompt || prompt.length === 0) return "Done — waiting for input";
	const maxLen = 72;
	const truncated = prompt.length > maxLen ? prompt.slice(0, maxLen - 3).trimEnd() + "…" : prompt;
	return `Done — "${truncated}"`;
}

// ---------------------------------------------------------------------------
// Platform-specific notification functions
// ---------------------------------------------------------------------------

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

/** freedesktop notification (Linux). Uses sound-name hint for daemons that
 *  respect the spec (GNOME, Plasma, mako). Dunst ignores it by default
 *  but that's user-configurable. */
function notifyLinux(title: string, body: string): void {
	execFile("notify-send", [
		"--app-name=pi",
		"--hint=string:sound-name:message",
		title,
		body,
	]);
}

/** macOS native notification. `sound name "default"` plays the system
 *  notification sound — same as Messages, Mail, etc. */
function notifyMacOS(title: string, body: string): void {
	execFile("osascript", [
		"-e",
		`display notification "${body}" with title "${title}" sound name "default"`,
	]);
}

/** Windows Toast notification. Plays the system default notification sound
 *  automatically (no explicit sound config needed). */
function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

// --- Terminal escape-code notifications (no sound — purely visual) ---

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

// ---------------------------------------------------------------------------
// Extension entry point — probes system, then hooks agent_end
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let isFocused = true; // Assume focused until terminal tells us otherwise
	let hasNotifiedThisWait = false;

	function triggerNotification(title: string, body: string) {
		if (hasNotifiedThisWait) return;
		hasNotifiedThisWait = true;

		if (backends.macos) notifyMacOS(title, body);
		if (backends.linux) notifyLinux(title, body);
		if (backends.windowsToast) notifyWindows(title, body);
		if (backends.osc99) notifyOSC99(title, body);
		if (backends.osc777) notifyOSC777(title, body);
	}

	function handleStdinData(data: Buffer) {
		const str = data.toString();
		if (str.includes("\x1b[I")) isFocused = true;
		if (str.includes("\x1b[O")) isFocused = false;
	}

	let probePromise: Promise<void> | null = null;
	let probeComplete = false;

	function ensureProbed(): Promise<void> {
		if (probePromise) return probePromise;
		probePromise = Promise.all([
			probeBin("notify-send"),
			probeBin("powershell.exe"),
			probeBin("osascript"),
		]).then(([hasNotifySend, hasPowershell, hasOsascript]) => {
			if (hasOsascript) backends.macos = true;
			else if (hasNotifySend) backends.linux = true;

			if (process.env.WT_SESSION && hasPowershell) backends.windowsToast = true;
			else if (process.env.KITTY_WINDOW_ID) backends.osc99 = true;
			else backends.osc777 = true;

			probeComplete = true;
		});
		return probePromise;
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		await ensureProbed();

		// Enable focus tracking and listen for events
		process.stdout.write("\x1b[?1004h");
		process.stdin.on("data", handleStdinData);

		const active: string[] = [];
		if (backends.macos) active.push("desktop (macOS)");
		if (backends.linux) active.push("desktop (Linux)");
		if (backends.osc777) active.push("OSC 777");
		if (backends.osc99) active.push("OSC 99 (Kitty)");
		if (backends.windowsToast) active.push("Windows Toast");

		ctx.ui.notify(`Notify: ${active.join(", ")} (Background only)`, "info");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Disable focus tracking and clean up listener
		process.stdout.write("\x1b[?1004l");
		process.stdin.removeListener("data", handleStdinData);
	});

	pi.on("agent_start", async () => {
		hasNotifiedThisWait = false;
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName === "ask_user_question") {
			hasNotifiedThisWait = false;
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.mode !== "tui" || isFocused || !probeComplete) return;

		const title = "Pi";
		const prompt = extractPrompt(event.messages);
		const body = buildBody(prompt);

		triggerNotification(title, body);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (ctx.mode !== "tui" || isFocused || !probeComplete) return;
		if (event.toolName === "ask_user_question") {
			const title = "Pi — Question";
			const q = event.input.question;
			const questionStr = typeof q === "string" ? q : "Waiting for user input...";
			const maxLen = 72;
			const truncated = questionStr.length > maxLen ? questionStr.slice(0, maxLen - 3).trimEnd() + "…" : questionStr;
			const body = `Question: "${truncated}"`;

			triggerNotification(title, body);
		}
	});
}
