/**
 * Token-scanning helpers shared by the rule handlers and the checker:
 * iterating positional arguments and matching longest subcommand prefixes.
 */

import { SHELL_OPERATORS } from "../config";

/**
 * Visits each positional (non-flag) argument after `tokens[i]`, in order.
 * Flags (tokens starting with `-`) are skipped; iteration stops at the first
 * shell operator, an empty token, or the end of the token list. `visit` may
 * return `false` to stop iteration early.
 */
export function forEachPositionalArg(
	tokens: string[],
	i: number,
	visit: (arg: string, j: number) => boolean | void,
): void {
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		if (visit(arg, j) === false) break;
		j++;
	}
}

/**
 * Collects up to `max` consecutive non-flag tokens starting at `start`.
 * Stops at the end of the list, at a flag, or once `max` parts are gathered.
 */
export function collectPositionalParts(tokens: string[], start: number, max: number): string[] {
	const parts: string[] = [];
	let j = start;
	while (j < tokens.length && tokens[j] && !tokens[j].startsWith("-") && parts.length < max) {
		parts.push(tokens[j]);
		j++;
	}
	return parts;
}

/**
 * Matches the longest prefix of `parts` present in `table`, longest first.
 * Returns the matched subcommand string, or `null` when nothing matches.
 */
export function matchLongestSubcommand(parts: string[], table: ReadonlySet<string>): string | null {
	for (let length = parts.length; length > 0; length--) {
		const sub = parts.slice(0, length).join(" ");
		if (table.has(sub)) return sub;
	}
	return null;
}