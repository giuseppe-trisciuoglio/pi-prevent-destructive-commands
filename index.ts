/**
 * Extension pi: "prevent-destructive-commands".
 *
 * Blocca (hard block) i comandi bash distruttivi prima dell'esecuzione.
 * Porting del hook Claude `prevent-destructive-commands.py`: stesso set di
 * regole (git, rm/path-sensitive, docker, aws, lettura file sensibili) e
 * stesso tokenizer ricorsivo per wrapper/shell/find/xargs.
 *
 * Il blocco è incondizionato: l'agente riceve il `reason` e deve cercare
 * un'alternativa. Non viene richiesta conferma interattiva.
 *
 * Installazione: ~/.pi/agent/extensions/prevent-destructive-commands/index.ts
 * Viene scoperta automaticamente da pi. Ricarica con /reload dopo le modifiche.
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
				reason: `Comando bloccato dalla protezione anti-distruttiva: ${reason}`,
			};
		}

		return undefined;
	});
}
