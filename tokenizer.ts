/**
 * Tokenizer shell minimale (stile shlex con punctuation_chars).
 *
 * Necessario perché Node non fornisce un equivalente di `shlex` della libreria
 * standard Python. Riproduce il comportamento del tokenizer del plugin Claude:
 * - rispetta single/double quotes e backslash escape
 * - separa gli operatori di shell (`|`, `;`, `&&`, `||`, `>`, `2>` ...) in token propri
 * - mantiene `$VAR` come token unico (a differenza di shlex posix con punctuation)
 * - riassembla il placeholder `{}` di find/xargs in un singolo token
 */

import { SHELL_OPERATORS } from "./config";

const OPERATORS_3 = ["2>>"];
const OPERATORS_2 = ["&&", "||", ">>", "<<", "2>"];
const OPERATORS_1 = new Set(["|", "&", ";", "(", ")", "{", "}", "<", ">"]);

/**
 * Verifica se, a partire da `i`, inizia un operatore shell.
 * Restituisce la lunghezza dell'operatore (1, 2 o 3) oppure 0.
 */
function operatorLengthAt(command: string, i: number): number {
	if (OPERATORS_3.includes(command.slice(i, i + 3))) return 3;
	const two = command.slice(i, i + 2);
	if (OPERATORS_2.includes(two)) return 2;
	if (OPERATORS_1.has(command[i])) return 1;
	return 0;
}

/**
 * Tokenizza un comando shell. Non solleva mai: in caso di quoting malformato
 * ricade su uno split semplicistico sul whitespace (fail-open sul parsing,
 * il checker resta comunque conservativo sui pattern noti).
 */
export function tokenize(command: string): string[] {
	const tokens: string[] = [];
	const n = command.length;
	let i = 0;

	while (i < n) {
		const ch = command[i];

		// Salta whitespace (inclusi newline)
		if (/\s/.test(ch)) {
			i++;
			continue;
		}

		// Placeholder find/xargs '{}' come token unico (prima degli operatori)
		if (command.slice(i, i + 2) === "{}") {
			tokens.push("{}");
			i += 2;
			continue;
		}

		// Operatori shell come token separati
		const opLen = operatorLengthAt(command, i);
		if (opLen > 0) {
			tokens.push(command.slice(i, i + opLen));
			i += opLen;
			continue;
		}

		// Token normale (con quotes/escape)
		const token = readWord(command, i);
		if (token.value.length > 0) tokens.push(token.value);
		i = token.next;
	}

	return tokens;
}

function readWord(command: string, start: number): { value: string; next: number } {
	const n = command.length;
	let i = start;
	let value = "";
	let inSingle = false;
	let inDouble = false;

	while (i < n) {
		const c = command[i];

		if (inSingle) {
			if (c === "'") {
				inSingle = false;
				i++;
			} else {
				value += c;
				i++;
			}
			continue;
		}

		if (inDouble) {
			if (c === '"') {
				inDouble = false;
				i++;
			} else if (c === "\\") {
				// In double quote, backslash protegge solo $ ` " \ newline
				const next = command[i + 1];
				if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
					value += next;
					i += 2;
				} else {
					value += c;
					i++;
				}
			} else {
				value += c;
				i++;
			}
			continue;
		}

		// Fuori da quote
		if (c === "'") {
			inSingle = true;
			i++;
		} else if (c === '"') {
			inDouble = true;
			i++;
		} else if (c === "\\") {
			const next = command[i + 1];
			if (next !== undefined) {
				value += next;
				i += 2;
			} else {
				i++;
			}
		} else if (/\s/.test(c) || operatorLengthAt(command, i) > 0) {
			// Boundary: termina il token
			break;
		} else if (command.slice(i, i + 2) === "{}") {
			// Placeholder '{}' anche in mezzo a una parola: chiude il token
			break;
		} else {
			value += c;
			i++;
		}
	}

	return { value, next: i };
}

/** Espone gli operatori per il checker (riconosce i separatori). */
export const OPERATORS = SHELL_OPERATORS;
