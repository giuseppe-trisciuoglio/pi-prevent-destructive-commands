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

	function startsOperator(): boolean {
		return SHELL_OPERATORS.has(input.slice(i, i + 2)) || SHELL_OPERATORS.has(input[i]!);
	}

	/**
	 * Reads one quoted segment starting at `input[i]` (a `'` or `"`) and moves past its closing quote.
	 * Single quotes keep everything literally; double quotes honour `\` escapes and may expand.
	 */
	function readQuoted(): { text: string; expands: boolean } {
		const quote = input[i];
		i++;
		let text = "";
		let expands = false;
		while (i < input.length && input[i] !== quote) {
			if (quote === '"' && input[i] === "\\" && i + 1 < input.length) {
				text += input[i + 1];
				i += 2;
				continue;
			}
			if (quote === '"' && (input[i] === "`" || (input[i] === "$" && (input[i + 1] === "(" || input[i + 1] === "{")))) expands = true;
			text += input[i];
			i++;
		}
		if (i < input.length) i++; // skip closing quote
		return { text, expands };
	}

	while (i < input.length) {
		const ch = input[i];

		// Shell operators are always separate tokens
		if (readOperator()) {
			continue;
		}

		// Single-quoted string: everything until closing quote, no escaping
		if (ch === "'" || ch === '"') {
			const isAttached = /^-.*=$/.test(current);
			if (isAttached) attached.add(tokens.length + 1);
			flush();
			let segment = readQuoted();
			let value = segment.text;
			let expands = segment.expands;
			if (isAttached) {
				// `--opt=''/etc/x` is one shell word: the attached value is everything up to the
				// next whitespace or operator, quoted or not, so the path is not split off.
				while (i < input.length && !/\s/.test(input[i]!) && !startsOperator()) {
					if (input[i] === "'" || input[i] === '"') {
						segment = readQuoted();
						value += segment.text;
						expands ||= segment.expands;
					} else if (input[i] === "\\" && i + 1 < input.length) {
						value += input[i + 1];
						i += 2;
					} else {
						if (input[i] === "`" || (input[i] === "$" && (input[i + 1] === "(" || input[i + 1] === "{"))) expands = true;
						value += input[i];
						i++;
					}
				}
			}
			if (expands) expandableTokens.add(value);
			tokens.push(value);
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
