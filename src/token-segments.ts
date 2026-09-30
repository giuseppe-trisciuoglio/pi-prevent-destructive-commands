/**
 * Token-sequence segmentation helpers shared by the bash-level guards.
 *
 * A "segment" is a maximal run of tokens between shell separators such as
 * `|`, `;`, `&&`, `||`, `&`, `(`, `)`. Each segment is a single command
 * chain (possibly containing pipeline parts that the guards re-inspect).
 */

/** Shell tokens that separate one command chain from the next. */
export const COMMAND_SEPARATORS: ReadonlySet<string> = new Set([
	"|",
	";",
	"&&",
	"||",
	"&",
	"(",
	")",
]);

/**
 * Splits a token list at every separator, returning the runs of tokens between
 * them. Empty runs (caused by adjacent or trailing separators) are dropped.
 */
export function splitTokensBySeparators(tokens: readonly string[]): string[][] {
	const segments: string[][] = [];
	let segment: string[] = [];

	for (const token of tokens) {
		if (COMMAND_SEPARATORS.has(token)) {
			if (segment.length > 0) segments.push(segment);
			segment = [];
			continue;
		}
		segment.push(token);
	}

	if (segment.length > 0) segments.push(segment);
	return segments;
}