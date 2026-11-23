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
 * Token texts the shell expands before the program runs: unquoted or
 * double-quoted `$(`, `${` or a backtick (a single-quoted one is literal).
 * Cleared by `resetExpandableTokens()` at the start of each analysis.
 */
const expandableTokens = new Set<string>();

export function resetExpandableTokens(): void {
	expandableTokens.clear();
}

/** Whether a token with this text was seen unquoted or double-quoted with a shell expansion. */
export function isExpandableToken(text: string): boolean {
	return expandableTokens.has(text);
}

/** Per token array: indices of quoted tokens attached to a preceding `--opt=` (`--include='*.ts'`). */
const attachedValues = new WeakMap<readonly string[], Set<number>>();

/** Whether `tokens[index]` is a quoted value written attached to the preceding `--opt=` token. */
export function isAttachedValue(tokens: readonly string[], index: number): boolean {
	return attachedValues.get(tokens)?.has(index) ?? false;
}

/** `tokens.slice(start)`, keeping the attached-value information of the source array. */
export function sliceTokens(tokens: readonly string[], start: number): string[] {
	const result = tokens.slice(start);
	const source = attachedValues.get(tokens);
	if (source !== undefined) {
		attachedValues.set(result, new Set([...source].filter((index) => index >= start).map((index) => index - start)));
	}
	return result;
}

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
	const attached = new Set<number>();
	attachedValues.set(tokens, attached);
	let current = "";
	let i = 0;

	function flush() {
		if (current.length > 0) {
			if (/`|\$[({]/.test(current)) expandableTokens.add(current);
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
			if (/^-.*=$/.test(current)) attached.add(tokens.length + 1);
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
			if (/^-.*=$/.test(current)) attached.add(tokens.length + 1);
			flush();
			i++;
			let quoted = "";
			let expands = false;
			while (i < input.length && input[i] !== '"') {
				if (input[i] === "\\" && i + 1 < input.length) {
					quoted += input[i + 1];
					i += 2;
				} else {
					if (input[i] === "`" || (input[i] === "$" && (input[i + 1] === "(" || input[i + 1] === "{"))) expands = true;
					quoted += input[i];
					i++;
				}
			}
			if (expands) expandableTokens.add(quoted);
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
