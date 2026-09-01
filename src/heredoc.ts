/**
 * Heredoc extraction.
 *
 * A heredoc body is stdin *data* for the command carrying the `<<` redirect,
 * not a command line. Prose written through `cat > file <<EOF` must not be
 * token-analyzed as shell syntax, because natural-language words collide with
 * real command names (for example the Italian preposition "del" matches the
 * Windows delete command, and the word right after it is then validated as a
 * filesystem path, which markdown emphasis and absolute paths mentioned in
 * text routinely fail).
 *
 * The extractor removes heredoc bodies from the command text and returns them
 * separately, so the checker can decide — based on whether the remaining
 * command line contains an executor (a shell, an interpreter, ssh, …) —
 * whether a body can actually be executed and therefore deserves command
 * analysis. Bodies that only feed data sinks (cat, tee, grep, …) are skipped.
 *
 * Parsing is deliberately conservative: anything that is not unambiguously a
 * plain heredoc makes the whole function bail out with `null`, and the caller
 * falls back to analyzing the original string exactly as it did before this
 * extraction existed. Bailing keeps the guard strict rather than opening
 * parsing holes.
 */

export interface HeredocExtraction {
	/** The command text with heredoc bodies removed. */
	text: string;
	/** Heredoc bodies, in the order the shell would consume them. */
	bodies: string[];
}

interface PendingHeredoc {
	delimiter: string;
	/** `true` for `<<-`, where the terminator may be indented with tabs. */
	stripTabs: boolean;
}

/**
 * Characters that may legally follow a heredoc delimiter without being part
 * of it (the delimiter word ends there and the rest of the command resumes).
 */
const OPERATOR_BOUNDARY = new Set([";", "|", "&", "<", ">", "(", ")", "{", "}"]);

/** Characters that must never appear in a bare (unquoted) delimiter word. */
const BARE_DELIMITER_STOP = new Set([
	" ",
	"\t",
	";",
	"|",
	"&",
	"<",
	">",
	"(",
	")",
	"{",
	"}",
	"'",
	'"',
	"$",
	"`",
	"\\",
]);

/** Extracts heredoc bodies from a raw command string. */
export function extractHeredocs(command: string): HeredocExtraction | null {
	const lines = command.split("\n");
	const textLines: string[] = [];
	const bodies: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const pending = scanForHeredocs(lines[i]);
		if (pending === null) return null;

		textLines.push(lines[i]);
		i++;

		// With several redirects on one line the shell reads the bodies in the
		// order the delimiters appear, which is exactly this loop.
		for (const heredoc of pending) {
			const body: string[] = [];
			while (i < lines.length && !isTerminator(lines[i], heredoc)) {
				body.push(lines[i]);
				i++;
			}
			if (i >= lines.length) {
				// Unterminated heredoc: refuse to guess, analyze everything.
				return null;
			}
			i++; // skip the terminator line
			bodies.push(body.join("\n"));
		}
	}

	return { text: textLines.join("\n"), bodies };
}

/**
 * Finds every heredoc redirect on a single command line, ignoring `<<`
 * occurrences inside quotes and `<<<` here-strings (their operand stays part
 * of the command text). Returns `null` when the line cannot be parsed with
 * certainty.
 */
function scanForHeredocs(line: string): PendingHeredoc[] | null {
	const found: PendingHeredoc[] = [];
	let quote: "'" | '"' | null = null;
	let i = 0;

	while (i < line.length) {
		const ch = line[i];

		if (quote) {
			if (ch === quote && (quote === "'" || line[i - 1] !== "\\")) {
				quote = null;
			}
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			i++;
			continue;
		}
		if (ch === "\\" && i + 1 < line.length) {
			i += 2;
			continue;
		}
		if (ch !== "<" || line[i + 1] !== "<") {
			i++;
			continue;
		}

		// A here-string (`<<< word`) feeds one word of data, not lines: it is
		// not a heredoc, skip it untouched.
		if (line[i + 2] === "<") {
			i += 3;
			continue;
		}

		let j = i + 2;
		let stripTabs = false;
		if (line[j] === "-") {
			stripTabs = true;
			j++;
		}
		while (j < line.length && (line[j] === " " || line[j] === "\t")) {
			j++;
		}

		const parsed = parseDelimiter(line, j);
		if (parsed === null) return null;
		found.push({ delimiter: parsed.delimiter, stripTabs });
		i = parsed.next;
	}

	return found;
}

interface ParsedDelimiter {
	delimiter: string;
	/** Index where scanning of the rest of the line should resume. */
	next: number;
}

/**
 * Reads the delimiter word starting at `start`. Only shapes the shell would
 * accept without expansion tricks are supported; anything else bails so the
 * caller keeps the stricter legacy analysis.
 */
function parseDelimiter(line: string, start: number): ParsedDelimiter | null {
	const first = line[start];

	// Empty delimiter (end of line or an operator immediately after `<<`).
	if (first === undefined || first === " " || first === "\t") return null;
	if (OPERATOR_BOUNDARY.has(first)) return null;

	if (first === "'" || first === '"') {
		const close = line.indexOf(first, start + 1);
		if (close === -1) return null;
		const delimiter = line.slice(start + 1, close);
		if (delimiter.length === 0) return null;
		if (/[$`\\]/.test(delimiter)) return null;
		const next = line[close + 1];
		// Words like `<<'E'OF` concatenate into a different delimiter than the
		// one read here: refuse instead of guessing.
		if (next !== undefined && next !== " " && next !== "\t" && !OPERATOR_BOUNDARY.has(next)) {
			return null;
		}
		return { delimiter, next: close + 1 };
	}

	// Bare delimiter word.
	let end = start;
	while (end < line.length && !BARE_DELIMITER_STOP.has(line[end])) {
		end++;
	}
	const delimiter = line.slice(start, end);
	if (delimiter.length === 0) return null;
	const next = line[end];
	// Mid-word quoting or expansion (`<<EOF'x'`, `<<EOF$y`) changes the real
	// terminator in ways that cannot be mirrored here: refuse.
	if (next === "'" || next === '"' || next === "$" || next === "`" || next === "\\") {
		return null;
	}
	return { delimiter, next: end };
}

/** A body line terminates the heredoc when it equals the delimiter exactly. */
function isTerminator(line: string, heredoc: PendingHeredoc): boolean {
	const candidate = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
	return candidate === heredoc.delimiter;
}
