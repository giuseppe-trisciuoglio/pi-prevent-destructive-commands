/**
 * Extension pi: "prevent-destructive-commands".
 *
 * Blocca (hard block) prima dell'esecuzione:
 * - i comandi bash distruttivi (git/rm/docker/aws/...); stesso tokenizer e
 *   stessa analisi ricorsiva dell'hook Claude `prevent-destructive-commands.py`;
 * - le scritture sui path protetti in WRITE_PROTECTED_PATHS (es. le guardie SDD
 *   `docs/specs/guards`) da qualunque strumento: bash (redirect/cp/mv/chmod/...),
 *   `write`, `edit`, `apply_patch`.
 *
 * Il blocco è incondizionato: l'agente riceve il `reason` e deve cercare
 * un'alternativa. Non viene richiesta conferma interattiva.
 *
 * Installazione: ~/.pi/agent/extensions/prevent-destructive-commands/index.ts
 * Viene scoperta automaticamente da pi. Ricarica con /reload dopo le modifiche.
 */

import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { tokenize } from "./tokenizer";
import { checkTokens, isUnderProtected } from "./checker";
import { ENABLE_WRITE_PROTECTION } from "./config";

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName;

		// ── bash: anti-distruttivo + write-protection (redirect/cp/mv/chmod/...) ──
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (typeof command === "string" && command.length > 0) {
				const { dangerous, reason } = checkTokens(tokenize(command), ctx.cwd);
				if (dangerous) {
					return {
						block: true,
						reason: `Comando bloccato dalla protezione anti-distruttiva: ${reason}`,
					};
				}
			}
			return undefined;
		}

		// ── write/edit/apply_patch: write-protection sui path protetti ──
		if (!ENABLE_WRITE_PROTECTION) return undefined;

		// Tool di scrittura con path diretto: write/edit e i tool MCP JetBrains
		// (replace_text_in_file, rename_refactoring, apply_quick_fix) che espongono
		// il path in un campo specifico.
		const pathField = WRITE_TOOL_PATH_FIELDS[toolName];
		if (pathField) {
			const p = (event.input as Record<string, unknown>)[pathField];
			if (typeof p === "string" && isUnderProtected(p, ctx.cwd)) {
				return {
					block: true,
					reason: `Scrittura su path protetto vietata: ${p}`,
				};
			}
			return undefined;
		}

		// apply_patch / applyPatch: i path vivono nel testo della patch.
		if (toolName === "apply_patch" || toolName === "applyPatch") {
			const input = event.input as { input?: unknown; patch?: unknown };
			const patch =
				typeof input.input === "string"
					? input.input
					: typeof input.patch === "string"
						? input.patch
						: "";
			const hits = protectedPathsInPatch(patch, ctx.cwd);
			if (hits.length) {
				return {
					block: true,
					reason: `apply_patch su path protetto vietato: ${hits.join(", ")}`,
				};
			}
		}

		return undefined;
	});
}

/**
 * Mappa `nome tool` → nome del campo in `input` che contiene il path del file
 * su cui il tool scrive. Usata per estendere la write-protection oltre ai soli
 * `write`/`edit` nativi (tool MCP JetBrains inclusi).
 */
const WRITE_TOOL_PATH_FIELDS: Readonly<Record<string, string>> = {
	write: "path",
	edit: "path",
	replace_text_in_file: "pathInProject",
	rename_refactoring: "pathInProject",
	apply_quick_fix: "filePath",
};

/**
 * Estrae i path di destinazione da un testo di patch (formato Codex
 * `apply_patch` e unified diff) e restituisce quelli che cadono sotto un path
 * protetto in scrittura. Riconosce gli header `*** Add/Update/Delete/Move File`
 * e le righe `---`/`+++`, normalizzando i prefissi `a/`/`b/` tipici del diff.
 */
function protectedPathsInPatch(patch: string, cwd: string): string[] {
	const hits = new Set<string>();
	const headers: RegExp[] = [
		/^\*\*\*\s+(?:Add File|Delete File|Update File|Move File|Add|Delete|Update|Move|Moved):?\s+(.+)$/gm,
		/^(?:---|\+\+\+)\s+(.+)$/gm,
	];

	for (const re of headers) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(patch)) !== null) {
			const raw = m[1].trim();
			// "Move File: a to b" -> valuta entrambi gli estremi
			for (const part of raw.split(/\s+to\s+/)) {
				const candidate = part.trim().replace(/^[ab]\//, "");
				if (candidate && isUnderProtected(candidate, cwd)) {
					hits.add(candidate);
				}
			}
		}
	}

	return [...hits];
}
