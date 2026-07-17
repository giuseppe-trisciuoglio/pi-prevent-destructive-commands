/**
 * pi Extension: "prevent-destructive-commands".
 *
 * Unconditionally blocks destructive bash commands before execution.
 * A faithful port of the Claude hook `prevent-destructive-commands.py`:
 * same rule set (git, rm/path-sensitive, docker, aws, sensitive file reads)
 * and same recursive tokenizer for wrappers/shell/find/xargs.
 *
 * The block is unconditional: the agent receives the `reason` and must find
 * an alternative. No interactive confirmation is ever requested.
 *
 * Installation: ~/.pi/agent/extensions/prevent-destructive-commands/index.ts
 * Automatically discovered by pi. Reload with /reload after changes.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tokenize } from "./tokenizer";
import { checkTokens } from "./checker";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return undefined;

		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;

		const { dangerous, reason } = checkTokens(tokenize(command), ctx.cwd);

		if (dangerous) {
			return {
				block: true,
				reason: `[prevent-destructive-commands] Blocked: ${reason}`,
			};
		}

		return undefined;
	});
}
