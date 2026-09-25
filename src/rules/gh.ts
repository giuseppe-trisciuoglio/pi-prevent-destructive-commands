/** Detects destructive GitHub CLI operations (`gh api -X DELETE`, `gh repo delete`, ...). */

import { GH_DESTRUCTIVE_METHODS, GH_DESTRUCTIVE_SUBCOMMANDS } from "../config";
import { type CheckResult, SAFE, block } from "./types";

/**
 * Checks tokens after `gh` for destructive method flags or subcommands.
 * A matching `-X`, `--method`, or `--method=` value anywhere in the remaining
 * tokens blocks, as does a configured noun/verb pair immediately after `gh`
 * when no option precedes it.
 * Returns a blocking result with its reason, or `SAFE` when neither matches.
 *
 * @param i Index of the `gh` token in `tokens`.
 */
export function checkGh(tokens: string[], i: number): CheckResult {
	// Any method flag on the line (`gh api ... -X DELETE ...`): find it wherever
	// it appears. Both short and long forms take the method as their value.
	for (let j = i + 1; j < tokens.length; j++) {
		const token = tokens[j];
		const value = token.startsWith("--method=")
			? token.slice("--method=".length)
			: token === "-X" || token === "--method"
				? tokens[j + 1]
				: undefined;
		if (value !== undefined && GH_DESTRUCTIVE_METHODS.has(value.toUpperCase())) {
			return block(`destructive GitHub CLI operation: gh api with method ${value.toUpperCase()}`);
		}
	}

	// `gh <noun> <verb>`: match the longest known destructive subcommand pair.
	const parts: string[] = [];
	let j = i + 1;
	while (j < tokens.length && !tokens[j].startsWith("-") && parts.length < 2) {
		parts.push(tokens[j]);
		j++;
	}
	for (let length = parts.length; length > 0; length--) {
		const sub = parts.slice(0, length).join(" ");
		if (GH_DESTRUCTIVE_SUBCOMMANDS.has(sub)) {
			return block(`destructive GitHub CLI operation: gh ${sub}`);
		}
	}
	return SAFE;
}
