/**
 * Classifies the program and pattern operands of text tools and interpreters
 * for the workdir boundary guard. These operands are code or regular
 * expressions, not filesystem paths, so a leading `/` (`awk '/x/'`,
 * `grep '/api/'`, `node -e "s.replace(/a/,'b')"`) must not be read as an
 * absolute path. Input-file operands and path-valued options (`-f progfile`,
 * `--file`, script files) are left unclassified, so they stay checked.
 *
 * See issue #46 and `docs/adr/0012-program-and-pattern-operands.md`.
 */

import { SHELL_OPERATORS } from "../config";

/** Language of an inline program, used to extract its string literals. */
export type ProgramLanguage = "awk" | "js" | "python" | "ruby" | "perl";

export interface ProgramOperandClassification {
	/** Token indices holding regular-expression patterns or free text (never paths). */
	patternIndices: Set<number>;
	/** Token indices holding inline program text, with its language. */
	programIndices: Map<number, ProgramLanguage>;
}

interface ToolSpec {
	/** Short option letters that take a value (attached or as the next token). */
	shortValueLetters: string;
	/** Short option letters whose value is a pattern or program (not a path). */
	shortPatternLetters: string;
	/** Long options that take a separate value. */
	longValueOptions: ReadonlySet<string>;
	/** Long options whose value is a pattern or program (not a path). */
	longPatternOptions: ReadonlySet<string>;
	/** Short letters / long options that supply the program or pattern, so no positional one follows. */
	suppliesProgram: (flag: string) => boolean;
	/** Program language for an inline program; `undefined` for pattern tools. */
	language?: ProgramLanguage;
	/** Whether the first positional operand is the program/pattern when none was supplied by an option. */
	positionalProgram: boolean;
}

const GREP_SPEC: ToolSpec = {
	shortValueLetters: "efmABCdD",
	shortPatternLetters: "e",
	longValueOptions: new Set([
		"--regexp",
		"--file",
		"--max-count",
		"--after-context",
		"--before-context",
		"--context",
		"--directories",
		"--devices",
		"--include",
		"--exclude",
		"--exclude-dir",
		"--exclude-from",
		"--label",
		"--binary-files",
	]),
	longPatternOptions: new Set(["--regexp", "--label"]),
	suppliesProgram: (flag) => ["e", "f", "--regexp", "--file"].includes(flag),
	positionalProgram: true,
};

const RG_SPEC: ToolSpec = {
	shortValueLetters: "efgtTmABCjMErd",
	shortPatternLetters: "er",
	longValueOptions: new Set([
		"--regexp",
		"--file",
		"--glob",
		"--iglob",
		"--type",
		"--type-not",
		"--type-add",
		"--type-clear",
		"--max-count",
		"--after-context",
		"--before-context",
		"--context",
		"--threads",
		"--max-columns",
		"--max-depth",
		"--max-filesize",
		"--encoding",
		"--replace",
		"--sort",
		"--sortr",
		"--colors",
		"--pre",
		"--pre-glob",
		"--ignore-file",
		"--path-separator",
		"--engine",
		"--context-separator",
		"--field-match-separator",
		"--field-context-separator",
		"--color",
		"--hyperlink-format",
		"--dfa-size-limit",
		"--regex-size-limit",
		"--hostname-bin",
		"--generate",
	]),
	longPatternOptions: new Set(["--regexp", "--replace", "--context-separator"]),
	// With `--files` / `--type-list` rg takes no pattern: every positional is a path.
	suppliesProgram: (flag) => ["e", "f", "--regexp", "--file", "--files", "--type-list", "--help"].includes(flag),
	positionalProgram: true,
};

const AG_SPEC: ToolSpec = {
	shortValueLetters: "ABCGgmp",
	shortPatternLetters: "Gg",
	longValueOptions: new Set([
		"--after",
		"--before",
		"--context",
		"--file-search-regex",
		"--ignore",
		"--ignore-dir",
		"--max-count",
		"--path-to-ignore",
		"--depth",
		"--pager",
	]),
	longPatternOptions: new Set(["--file-search-regex", "--ignore", "--ignore-dir"]),
	// `-g PATTERN` lists files matching PATTERN: no positional pattern follows.
	// (`-G` only filters the files searched for the positional pattern.)
	suppliesProgram: (flag) => flag === "g",
	positionalProgram: true,
};

const AWK_SPEC: ToolSpec = {
	shortValueLetters: "fvFeEil",
	shortPatternLetters: "Fe",
	longValueOptions: new Set(["--file", "--assign", "--field-separator", "--source", "--exec", "--include", "--load"]),
	longPatternOptions: new Set(["--field-separator", "--source"]),
	suppliesProgram: (flag) => ["f", "e", "E", "--file", "--source", "--exec"].includes(flag),
	language: "awk",
	positionalProgram: true,
};

/** Interpreters whose `-e`-style option carries inline program text. */
function interpreterSpec(language: ProgramLanguage, valueLetters: string, programLetters: string, longValue: string[], longProgram: string[]): ToolSpec {
	return {
		shortValueLetters: valueLetters,
		shortPatternLetters: programLetters,
		longValueOptions: new Set(longValue),
		longPatternOptions: new Set(longProgram),
		suppliesProgram: () => false,
		language,
		positionalProgram: false,
	};
}

const NODE_SPEC = interpreterSpec(
	"js",
	"eprC",
	"ep",
	[
		"--eval", "--print", "--require", "--import", "--input-type", "--conditions", "--loader", "--experimental-loader",
		"--env-file", "--max-old-space-size", "--max-semi-space-size", "--stack-size", "--stack-trace-limit",
		"--title", "--inspect-port", "--max-http-header-size", "--watch-path", "--experimental-default-type",
		"--disable-warning", "--redirect-warnings", "--openssl-config", "--icu-data-dir", "--dns-result-order",
		"--unhandled-rejections", "--heapsnapshot-signal", "--diagnostic-dir", "--report-dir", "--report-signal",
		"--secure-heap", "--secure-heap-min", "--test-reporter", "--test-name-pattern", "--cpu-prof-dir", "--heap-prof-dir",
	],
	["--eval", "--print"],
);
const PYTHON_SPEC = interpreterSpec("python", "cmWX", "c", [], []);
const RUBY_SPEC = interpreterSpec("ruby", "erICFE", "e", [], []);
const PERL_SPEC = interpreterSpec("perl", "eEIMmxFiC0ldD", "eE", [], []);

/** Value-taking letters that consume the rest of the cluster but may be empty (optional value). */
const OPTIONAL_ATTACHED_LETTERS: Record<string, string> = { perl: "iFlx0CdD" };

/** perl `-l[octal]` / `-0[octal|xHEX]`: the optional value is digits only, the cluster goes on (`-lne`). */
const PERL_NUMERIC_VALUE: Record<string, RegExp> = { l: /^[0-7]*/, "0": /^(?:x[0-9a-fA-F]*|[0-7]*)/ };

/** `deno eval` options that take a separate value token (the value stays unclassified, so it is checked). */
const DENO_VALUE_OPTIONS = new Set([
	"--ext", "--import-map", "-c", "--config", "--location", "--cert", "--seed", "--log-level", "-L",
	"--v8-flags", "--lock", "--env-file", "--tsconfig", "--node-modules-dir", "--conditions", "--preload",
	"--import",
]);

/** `deno eval` options known to take no separate value. */
const DENO_BOOLEAN_OPTIONS = new Set([
	"-q", "--quiet", "-A", "--allow-all", "-p", "--print", "-T", "--ts", "--no-check", "--no-remote", "--no-npm",
	"--no-config", "--no-lock", "--cached-only", "--frozen", "--unstable", "--env", "--no-prompt",
	// Optional values are attached with `=`, so these never take a separate value token.
	"--check", "--reload", "-r", "--watch", "--watch-hmr", "--no-clear-screen", "--inspect", "--inspect-brk", "--inspect-wait",
	"--unsafely-ignore-certificate-errors", "--lock-write", "--no-terminal-colors", "--no-code-cache", "--sloppy-imports",
	"--vendor", "--no-vendor", "--check-js", "--no-npm-install", "--prefer-offline",
]);

/** A split `--opt=` value that is plainly a quoted value (glob or list characters), not a bare word. */
const SPLIT_VALUE_HINT = /[*?[\]{}!,\s]/;

function isKnownDenoBoolean(option: string): boolean {
	return DENO_BOOLEAN_OPTIONS.has(option) || /^--(?:allow|deny|unstable)-[a-z-]+$/.test(option);
}

/**
 * Index of the first operand after the deno options starting at `j`, or `-1`
 * when an option is not recognised (its value could be the next token).
 */
function skipDenoOptions(tokens: readonly string[], j: number): number {
	while (j < tokens.length && tokens[j]!.startsWith("-") && !SHELL_OPERATORS.has(tokens[j]!)) {
		const token = tokens[j]!;
		const eq = token.indexOf("=");
		const option = eq > 0 ? token.slice(0, eq) : token;
		if (!DENO_VALUE_OPTIONS.has(option) && !isKnownDenoBoolean(option)) return -1;
		// The tokenizer splits `--opt='v'` into `--opt=` and `v`: `v` is the value.
		if (eq > 0 && eq === token.length - 1) j++;
		else if (eq < 0 && DENO_VALUE_OPTIONS.has(option)) j++;
		j++;
	}
	return j;
}

function specFor(command: string): { spec: ToolSpec; name: string } | null {
	if (command === "grep" || command === "egrep" || command === "fgrep") return { spec: GREP_SPEC, name: "grep" };
	if (command === "rg") return { spec: RG_SPEC, name: "rg" };
	if (command === "ag") return { spec: AG_SPEC, name: "ag" };
	if (command === "awk" || command === "gawk" || command === "mawk" || command === "nawk") return { spec: AWK_SPEC, name: "awk" };
	if (command === "node" || command === "nodejs" || command === "bun") return { spec: NODE_SPEC, name: "node" };
	if (/^python[0-9.]*$/.test(command)) return { spec: PYTHON_SPEC, name: "python" };
	if (command === "ruby") return { spec: RUBY_SPEC, name: "ruby" };
	if (command === "perl") return { spec: PERL_SPEC, name: "perl" };
	return null;
}

/**
 * Classifies the operands of the simple command starting at `tokens[index]`.
 * Returns `null` when the command is not a known text tool or interpreter.
 */
export function classifyProgramOperands(tokens: readonly string[], index: number): ProgramOperandClassification | null {
	const command = tokens[index]!;
	const patternIndices = new Set<number>();
	const programIndices = new Map<number, ProgramLanguage>();

	// `deno eval "code"`: the operand after `eval` is a JS program.
	if (command === "deno") {
		let j = skipDenoOptions(tokens, index + 1);
		if (j >= 0 && tokens[j] === "eval") {
			j = skipDenoOptions(tokens, j + 1);
			// Unrecognised option: classify nothing, every token gets the generic analysis.
			if (j < 0) return { patternIndices, programIndices };
			if (j < tokens.length && tokens[j] && !SHELL_OPERATORS.has(tokens[j]!)) programIndices.set(j, "js");
			return { patternIndices, programIndices };
		}
		return null;
	}

	const found = specFor(command);
	if (found === null) return null;
	const { spec, name } = found;
	const optionalAttached = OPTIONAL_ATTACHED_LETTERS[name] ?? "";

	const mark = (j: number) => {
		if (spec.language !== undefined) programIndices.set(j, spec.language);
		else patternIndices.add(j);
	};
	const markPattern = (j: number, letterOrOption: string) => {
		// awk -F and grep/rg/ag patterns are regexes; interpreter -e and awk -e/--source are programs.
		if (spec.language === undefined || letterOrOption === "F" || letterOrOption === "--field-separator") {
			patternIndices.add(j);
		} else {
			programIndices.set(j, spec.language);
		}
	};

	let supplied = false;
	let positionalDone = !spec.positionalProgram;
	let optionsEnded = false;

	for (let j = index + 1; j < tokens.length; j++) {
		const token = tokens[j];
		if (!token || SHELL_OPERATORS.has(token)) break;

		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("--")) {
			const eq = token.indexOf("=");
			const option = eq > 0 ? token.slice(0, eq) : token;
			if (spec.suppliesProgram(option)) supplied = true;
			const nextToken = j + 1 < tokens.length ? tokens[j + 1]! : undefined;
			if (eq > 0 && eq === token.length - 1 && name === "node" && spec.longPatternOptions.has(option)) {
				// `--eval='code'` is split into `--eval=` and `code`: the next token is the program.
				if (nextToken !== undefined && nextToken !== "" && !nextToken.startsWith("-") && !SHELL_OPERATORS.has(nextToken)) {
					programIndices.set(j + 1, "js");
					j++;
				}
				continue;
			}
			if (eq > 0 && eq === token.length - 1 && spec.longValueOptions.has(option) && nextToken !== undefined) {
				// The tokenizer splits `--include='*.ts'` into `--include=` and `*.ts`: the next token is
				// the value. It is left unclassified (still checked as a path), since `--regexp= /x`
				// cannot be told apart from it. An option-like next token is not a value, and a plain word
				// (`rg --color= foo /etc`) may be an empty value followed by the pattern: it is not consumed, so
				// the operand after it is checked as a path. Only glob-like values (`*.ts`) are consumed.
				if (nextToken === "" || (!nextToken.startsWith("-") && SPLIT_VALUE_HINT.test(nextToken))) j++;
				else if (!nextToken.startsWith("-")) positionalDone = true; // no pattern is assumed: later operands stay checked
				continue;
			}
			if (eq > 0) {
				if (spec.longPatternOptions.has(option)) markPattern(j, option);
				continue;
			}
			if (spec.longValueOptions.has(option) && j + 1 < tokens.length) {
				// node `--print -e CODE`: `--print` takes an optional script, an option is not it.
				if (name === "node" && option === "--print" && /^-./.test(tokens[j + 1]!)) continue;
				if (spec.longPatternOptions.has(option)) markPattern(j + 1, option);
				j++;
			}
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token !== "-") {
			const letters = token.slice(1);
			for (let k = 0; k < letters.length; k++) {
				const letter = letters[k]!;
				if (!spec.shortValueLetters.includes(letter)) continue;
				const numeric = name === "perl" ? PERL_NUMERIC_VALUE[letter] : undefined;
				if (numeric !== undefined) {
					k += numeric.exec(letters.slice(k + 1))![0].length;
					continue;
				}
				// node: `-pe CODE` / `-ep CODE`: the program is the value of the last of `e`/`p`.
				if (name === "node" && "ep".includes(letter) && k + 1 < letters.length && "ep".includes(letters[k + 1]!)) continue;
				if (spec.suppliesProgram(letter)) supplied = true;
				const attached = letters.slice(k + 1);
				if (attached === "") {
					// node `-p -e CODE`: `-p` takes an optional script, an option is not it.
					if (name === "node" && letter === "p" && j + 1 < tokens.length && /^-./.test(tokens[j + 1]!)) break;
					if (!optionalAttached.includes(letter) && j + 1 < tokens.length) {
						if (spec.shortPatternLetters.includes(letter)) markPattern(j + 1, letter);
						j++;
					}
				} else if (spec.shortPatternLetters.includes(letter)) {
					markPattern(j, letter);
				}
				break;
			}
			// python: `-c`/`-m` end the interpreter's own options.
			if (name === "python" && /[cm]/.test(letters)) break;
			continue;
		}

		if (!positionalDone && !supplied) {
			mark(j);
			positionalDone = true;
			continue;
		}
		positionalDone = true;
		// Interpreters: the first positional is a script file, the rest are its arguments.
		if (spec.language !== undefined && spec.language !== "awk") break;
	}

	return { patternIndices, programIndices };
}

/** Quote characters that open string literals in each language. */
const LITERAL_QUOTES: Record<ProgramLanguage, string> = {
	awk: '"',
	js: "'\"`",
	python: "'\"",
	ruby: "'\"`",
	perl: "'\"`",
};

/** Quote-like string operators: perl `q(...)`/`qq{...}`/`qw[...]`/`qx<...>`, ruby `%q(...)`/`%w[...]`/`%(...)`. */
const QUOTE_LIKE: Partial<Record<ProgramLanguage, RegExp>> = {
	perl: /q[qwx]?\s*([^\w\s])/y,
	ruby: /%[qQwWiIx]?([^\w\s=])/y,
};

const CLOSING_BRACKET: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/** Scans a quote-like body opened by `open` at `start`; `null` when it is unterminated. */
function scanQuoteLike(program: string, start: number, open: string): { value: string; end: number } | null {
	const close = CLOSING_BRACKET[open] ?? open;
	let depth = 1;
	let value = "";
	for (let j = start; j < program.length; j++) {
		const character = program[j]!;
		if (character === "\\" && j + 1 < program.length) {
			value += program[j + 1];
			j++;
			continue;
		}
		if (character === close) {
			depth--;
			if (depth === 0) return { value, end: j + 1 };
		} else if (character === open) {
			depth++;
		}
		value += character;
	}
	return null;
}

/** A literal made only of slashes/whitespace (a separator such as `split(s, "/")`). */
const SLASH_ONLY = /^[\s/]*$/;

/** Filesystem calls whose argument is a path even when it is just `/`. */
const FS_CALL = /\b(?:rm|rmSync|rmdir|rmdirSync|rmtree|rm_rf|rm_r|unlink|unlinkSync|listdir|readdir|readdirSync|scandir|walk|open|opendir|chdir|chmod|chown|remove|removedirs|truncate|writeFile|writeFileSync|readFile|readFileSync|glob|Dir|File\.\w+|FileUtils\.\w+|os\.\w+|shutil\.\w+)\s*\(?\s*$/;

/** Calls whose first string argument is a regular expression, not a path. */
const REGEX_CALL = /(?:\bre\.(?:sub|subn|match|fullmatch|search|compile|findall|finditer|split)|\bRegExp|\bRegexp\.new)\s*\(\s*$/;

/**
 * Extracts the string literals of an inline program. Returns `null` when the
 * scan ends inside an unterminated literal (e.g. a quote inside a regex
 * literal desynchronised it): the caller then falls back to the generic,
 * conservative token analysis.
 */
export function extractProgramLiterals(program: string, language: ProgramLanguage): string[] | null {
	const quotes = LITERAL_QUOTES[language];
	const literals: string[] = [];
	let i = 0;
	while (i < program.length) {
		const character = program[i]!;
		if (language === "python" && character === "#") {
			while (i < program.length && program[i] !== "\n") i++;
			continue;
		}
		const quoteLike = QUOTE_LIKE[language];
		if (quoteLike !== undefined && (language !== "perl" || i === 0 || !/[\w$@%&]/.test(program[i - 1]!))) {
			quoteLike.lastIndex = i;
			const match = quoteLike.exec(program);
			if (match !== null) {
				const body = scanQuoteLike(program, i + match[0].length, match[1]!);
				if (body === null) return null;
				if (!SLASH_ONLY.test(body.value) || FS_CALL.test(program.slice(0, i))) literals.push(body.value);
				i = body.end;
				continue;
			}
		}
		if (!quotes.includes(character)) {
			i++;
			continue;
		}
		const triple = language === "python" && program.startsWith(character.repeat(3), i);
		const delimiter = triple ? character.repeat(3) : character;
		const prefixMatch = language === "python" ? /([rRbBuUfF]{0,2})$/.exec(program.slice(0, i)) : null;
		const raw = prefixMatch !== null && /[rR]/.test(prefixMatch[1]!);
		const precededByRegexCall = REGEX_CALL.test(program.slice(0, i - (prefixMatch?.[1]?.length ?? 0)));
		let j = i + delimiter.length;
		let value = "";
		let closed = false;
		while (j < program.length) {
			if (!raw && program[j] === "\\" && j + 1 < program.length) {
				value += program[j + 1];
				j += 2;
				continue;
			}
			if (raw && program[j] === "\\" && j + 1 < program.length) {
				value += program.slice(j, j + 2);
				j += 2;
				continue;
			}
			if (program.startsWith(delimiter, j)) {
				closed = true;
				break;
			}
			value += program[j];
			j++;
		}
		if (!closed) return null;
		const before = program.slice(0, i - (prefixMatch?.[1]?.length ?? 0));
		const separator = SLASH_ONLY.test(value) && !FS_CALL.test(before);
		if (!precededByRegexCall && !separator) literals.push(value);
		i = j + delimiter.length;
	}
	return literals;
}
