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
	]),
	longPatternOptions: new Set(["--regexp", "--replace", "--context-separator"]),
	suppliesProgram: (flag) => ["e", "f", "--regexp", "--file"].includes(flag),
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
	suppliesProgram: () => false,
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

const NODE_SPEC = interpreterSpec("js", "eprC", "ep", ["--eval", "--print", "--require", "--import", "--input-type", "--conditions"], ["--eval", "--print"]);
const PYTHON_SPEC = interpreterSpec("python", "cmWX", "c", [], []);
const RUBY_SPEC = interpreterSpec("ruby", "erICFE", "e", [], []);
const PERL_SPEC = interpreterSpec("perl", "eEIMmxFiC0ldD", "eE", [], []);

/** Value-taking letters that consume the rest of the cluster but may be empty (optional value). */
const OPTIONAL_ATTACHED_LETTERS: Record<string, string> = { perl: "iFlx0CdD" };

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
		let j = index + 1;
		while (j < tokens.length && tokens[j]!.startsWith("-")) j++;
		if (tokens[j] === "eval") {
			j++;
			while (j < tokens.length && tokens[j]!.startsWith("-") && !SHELL_OPERATORS.has(tokens[j]!)) j++;
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
			if (eq > 0) {
				if (spec.longPatternOptions.has(option)) markPattern(j, option);
				continue;
			}
			if (spec.longValueOptions.has(option) && j + 1 < tokens.length) {
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
				if (spec.suppliesProgram(letter)) supplied = true;
				const attached = letters.slice(k + 1);
				if (attached === "") {
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
		if (!precededByRegexCall) literals.push(value);
		i = j + delimiter.length;
	}
	return literals;
}
