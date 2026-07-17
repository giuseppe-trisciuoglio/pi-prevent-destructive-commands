/**
 * Shell tokenizer (shlex-like).
 *
 * Port of the Claude plugin's tokenizer. Splits a shell command string into
 * individual tokens, respecting single quotes, double quotes, and backslash
 * escapes. Recognizes shell operators as separate tokens.
 *
 * The tokenizer must stay aligned with SHELL_OPERATORS in config.ts.
 */

import { SHELL_OPERATORS } from "./config";

/**
 * Tokenizes a shell command string into an array of tokens.
 *
 * - Single-quoted strings ('...') are preserved as-is (no escaping inside).
 * - Double-quoted strings ("...") support \ escapes.
 * - Unquoted tokens are split on whitespace.
 * - Shell operators (|, &&, ||, ;, etc.) are always separate tokens.
 *
 * @param input - The raw shell command string.
 * @returns Array of tokens, preserving quotes and structure.
 */
export function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let i = 0;

	function flush() {
		if (current.length > 0) {
			tokens.push(current);
			current = "";
		}
	}

	function readOperator(): boolean {
		// Try multi-char operators first (order matters: && before &, || before |)
		const twoChar = input.slice(i, i + 2);
		if (SHELL_OPERATORS.has(twoChar)) {
			flush();
			tokens.push(twoChar);
			i += 2;
			return true;
		}
		const oneChar = input[i];
		if (SHELL_OPERATORS.has(oneChar)) {
			flush();
			tokens.push(oneChar);
			i++;
			return true;
		}
		return false;
	}

	while (i < input.length) {
		const ch = input[i];

		// Shell operators are always separate tokens
		if (readOperator()) {
			continue;
		}

		// Single-quoted string: everything until closing quote, no escaping
		if (ch === "'") {
			flush();
			i++;
			const start = i;
			while (i < input.length && input[i] !== "'") {
				i++;
			}
			tokens.push(input.slice(start, i));
			if (i < input.length) i++; // skip closing quote
			continue;
		}

		// Double-quoted string: supports \ escapes
		if (ch === '"') {
			flush();
			i++;
			let quoted = "";
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length) {
					quoted += input[i + 1];
					i += 2;
				} else {
					quoted += input[i];
					i++;
				}
			}
			tokens.push(quoted);
			if (i < input.length) i++; // skip closing quote
			continue;
		}

		// Backslash escape outside quotes
		if (ch === "\\" && i + 1 < input.length) {
			current += input[i + 1];
			i += 2;
			continue;
		}

		// Whitespace separates tokens
		if (/\s/.test(ch)) {
			flush();
			i++;
			continue;
		}

		// Regular character
		current += ch;
		i++;
	}

	flush();
	return tokens;
}
