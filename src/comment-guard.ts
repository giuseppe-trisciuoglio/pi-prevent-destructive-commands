/**
 * Source comment guard.
 *
 * Agents tend to decorate the code they write with explanatory comments.
 * Projects that want self-documenting code can keep new comments out of
 * source files entirely: every writing tool call, plus the common bash write
 * vectors, is inspected and any comment that would appear in the final file
 * without already existing today — on disk or in the replaced text — blocks
 * the call.
 *
 * Rewriting, deleting and reordering code is never affected, and comments a
 * file already contains may be carried over untouched. Shebang lines and
 * recognized tooling directives (lint suppressions, formatter switches) stay
 * allowed because they steer tools rather than explain the code.
 */

import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { extractHeredocs } from "./heredoc";
import { splitTokensBySeparators } from "./token-segments";
import { tokenize } from "./tokenizer";

// =============================================================================
// Language map
// =============================================================================

/** Comment syntax families supported by the guard. */
type CommentFamily = "c" | "block" | "hash" | "dash" | "html";

/** File extensions whose comment syntax is C-family (line and block, or block only). */
const EXTENSION_FAMILIES: Readonly<Record<string, CommentFamily>> = {
	// C-family line and block comments
	java: "c",
	ts: "c",
	tsx: "c",
	mts: "c",
	cts: "c",
	js: "c",
	jsx: "c",
	mjs: "c",
	cjs: "c",
	dart: "c",
	go: "c",
	rs: "c",
	c: "c",
	h: "c",
	cpp: "c",
	cc: "c",
	cxx: "c",
	hpp: "c",
	hh: "c",
	hxx: "c",
	cs: "c",
	swift: "c",
	kt: "c",
	kts: "c",
	scala: "c",
	sc: "c",
	php: "c",
	groovy: "c",
	gradle: "c",
	sol: "c",
	zig: "c",
	scss: "c",
	less: "c",
	proto: "c",
	// Block comments only: plain CSS has no line comments
	css: "block",
	// Hash line comments
	py: "hash",
	pyi: "hash",
	pyw: "hash",
	rb: "hash",
	sh: "hash",
	bash: "hash",
	zsh: "hash",
	ksh: "hash",
	fish: "hash",
	r: "hash",
	pl: "hash",
	pm: "hash",
	jl: "hash",
	ex: "hash",
	exs: "hash",
	yml: "hash",
	yaml: "hash",
	toml: "hash",
	tf: "hash",
	tfvars: "hash",
	graphql: "hash",
	gql: "hash",
	cmake: "hash",
	// Double-dash line comments (plus SQL block comments)
	sql: "dash",
	lua: "dash",
	hs: "dash",
	elm: "dash",
	// SGML comments
	html: "html",
	htm: "html",
	xml: "html",
	svg: "html",
	md: "html",
	mdx: "html",
};

/** Hash-comment files identified by name rather than extension (Dockerfile, Makefile, …). */
const HASH_FILENAMES: ReadonlySet<string> = new Set([
	"dockerfile",
	"makefile",
	"gnumakefile",
	"jenkinsfile",
	".gitignore",
	".dockerignore",
	".editorconfig",
]);

const PYTHON_EXTENSIONS: ReadonlySet<string> = new Set(["py", "pyi", "pyw"]);

function commentFamilyForPath(path: string): CommentFamily | undefined {
	const name = basename(path).toLowerCase();
	if (HASH_FILENAMES.has(name) || name.endsWith(".dockerfile") || name.endsWith(".mk")) {
		return "hash";
	}
	return EXTENSION_FAMILIES[extname(name).slice(1)];
}

function isPythonPath(path: string): boolean {
	return PYTHON_EXTENSIONS.has(extname(basename(path).toLowerCase()).slice(1));
}

/** JavaScript/TypeScript: regex literals exist and quoted strings cannot span lines. */
const JS_EXTENSIONS: ReadonlySet<string> = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);

/** C-family stylesheets: `/` after `(` is a URL path (`url(/a.png)`), never a regex. */
const NO_REGEX_EXTENSIONS: ReadonlySet<string> = new Set(["scss", "less"]);

/** Scanner options derived from a file path. */
function scanOptionsForPath(path: string): ScanOptions {
	const extension = extname(basename(path).toLowerCase()).slice(1);
	const family = commentFamilyForPath(path);
	return {
		regexLiterals: family === "c" && !NO_REGEX_EXTENSIONS.has(extension),
		singleLineStrings: JS_EXTENSIONS.has(extension),
		rustLifetimes: extension === "rs",
	};
}

/** Comments of `content` for the file at `path`. */
function commentsForPath(content: string, path: string): SourceComment[] {
	return extractComments(content, commentFamilyForPath(path)!, isPythonPath(path), scanOptionsForPath(path));
}

// =============================================================================
// Comment extraction
// =============================================================================

export interface SourceComment {
	/** Line where the comment starts, relative to the scanned text. */
	line: number;
	/** Inner text without comment markers, trimmed. */
	text: string;
}

export interface ScanOptions {
	/** Recognise regex literals (`/'/g`) so quotes and `/*` inside them are ignored. */
	regexLiterals?: boolean;
	/** Quoted (`'`/`"`) strings cannot contain a raw newline; one that does means the scan desynchronised. */
	singleLineStrings?: boolean;
	/** Rust: `'` followed by an identifier and not closed right after (`'static`, `'a`) is a lifetime, not a char literal. */
	rustLifetimes?: boolean;
}

/**
 * Characters after which a `/` starts a regex literal rather than a division.
 * `}` is excluded: it closes a block as often as an expression (`{a} / 2`, a
 * JSX attribute before `/>`), and a missed regex only costs the fallback.
 */
const REGEX_PRECEDING_CHARACTERS = "(,=:[!&|?{;+-*%>~^";

/** Keywords after which a `/` starts a regex literal. */
const REGEX_PRECEDING_KEYWORDS: ReadonlySet<string> = new Set([
	"return",
	"typeof",
	"instanceof",
	"in",
	"of",
	"new",
	"delete",
	"void",
	"throw",
	"case",
	"do",
	"else",
	"yield",
	"await",
]);

/**
 * Line-based fallback used when the string-aware scan desynchronised: only
 * comments whose marker opens a line (after indentation) are reported, so a
 * marker in the middle of a line — typically inside a string the scanner lost
 * track of — never blocks a write.
 */
function extractLineComments(content: string, family: CommentFamily, lineOffset = 0): SourceComment[] {
	const comments: SourceComment[] = [];
	const lines = content.split("\n");
	const lineMarkers: Record<CommentFamily, string[]> = {
		c: ["//"],
		block: [],
		hash: ["#"],
		dash: ["--"],
		html: [],
	};
	const blockMarkers: Record<CommentFamily, [string, string] | undefined> = {
		c: ["/*", "*/"],
		block: ["/*", "*/"],
		hash: undefined,
		dash: ["/*", "*/"],
		html: ["<!--", "-->"],
	};
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index]!.trim();
		const lineMarker = lineMarkers[family].find((marker) => trimmed.startsWith(marker));
		if (lineMarker !== undefined) {
			comments.push({ line: lineOffset + index + 1, text: trimmed.slice(lineMarker.length).trim() });
			continue;
		}
		const block = blockMarkers[family];
		if (block === undefined || !trimmed.startsWith(block[0])) continue;
		const startLine = lineOffset + index + 1;
		let text = trimmed.slice(block[0].length);
		while (!text.includes(block[1]) && index + 1 < lines.length) {
			index++;
			text += `\n${lines[index]!}`;
		}
		const end = text.indexOf(block[1]);
		comments.push({ line: startLine, text: (end >= 0 ? text.slice(0, end) : text).trim() });
	}
	return comments;
}

/**
 * Extracts every comment from `content`, skipping string and template
 * literals so markers inside them (an URL like "https://…" inside quotes)
 * are not mistaken for comments. Python triple-quoted strings are skipped
 * for Python files, and C-family regex literals (`/'/g`, `/a\/*b/`) are
 * skipped when `options.regexLiterals` is set (the default for `"c"`).
 *
 * When the scan desynchronises — it ends inside an unterminated string, or a
 * quoted string spans a line in a language where that is impossible — the
 * comments found before the failing string are kept, and the lines after the
 * one where it opened fall back to `extractLineComments`, which never reports
 * a marker in the middle of a line. A false block costs more than a missed
 * comment.
 */
export function extractComments(
	content: string,
	family: CommentFamily,
	python = false,
	options: ScanOptions = { regexLiterals: family === "c", singleLineStrings: family === "c" },
): SourceComment[] {
	const comments: SourceComment[] = [];
	/** Offset of each comment's opening marker, parallel to `comments`. */
	const commentStarts: number[] = [];
	const length = content.length;
	let line = 1;
	let i = 0;
	/** Offset and line of the first string whose scan desynchronised. */
	let desync: { offset: number; line: number } | undefined;

	const markDesync = (offset: number, atLine: number): void => {
		desync ??= { offset, line: atLine };
	};

	const readString = (quote: string): void => {
		const start = i;
		const startLine = line;
		i++; // opening quote
		while (i < length) {
			const ch = content[i]!;
			if (ch === "\\" && i + 1 < length) {
				i += 2;
				continue;
			}
			i++;
			if (ch === quote) return;
			if (ch === "\n") {
				line++;
				if (options.singleLineStrings && quote !== "`") markDesync(start, startLine);
			}
		}
		markDesync(start, startLine);
	};

	/** Rust lifetime or label (`'static`, `'a`, `'outer:`): an identifier not closed by `'`. */
	const isRustLifetime = (): boolean => {
		if (!/[A-Za-z_]/.test(content[i + 1] ?? "")) return false;
		let k = i + 2;
		while (k < length && /[A-Za-z0-9_]/.test(content[k]!)) k++;
		return content[k] !== "'";
	};

	/** Whether the `/` at `i` is in an expression position, so it opens a regex literal. */
	const regexAllowedHere = (): boolean => {
		let k = i - 1;
		while (k >= 0 && (content[k] === " " || content[k] === "\t" || content[k] === "\r" || content[k] === "\n")) k--;
		if (k < 0) return true;
		const previous = content[k]!;
		const beforePrevious = k > 0 ? content[k - 1]! : "";
		// `i++ / n`, `i-- / n`: a postfix operator ends an operand.
		if ((previous === "+" || previous === "-") && beforePrevious === previous) return false;
		// `total! / n`, `f()! / n`: a TypeScript non-null assertion ends an operand.
		if (previous === "!" && /[A-Za-z0-9_$)\]]/.test(beforePrevious)) return false;
		if (REGEX_PRECEDING_CHARACTERS.includes(previous)) return true;
		if (!/[A-Za-z_$]/.test(previous)) return false;
		let start = k;
		while (start > 0 && /[A-Za-z0-9_$]/.test(content[start - 1]!)) start--;
		if (start > 0 && content[start - 1] === ".") return false;
		return REGEX_PRECEDING_KEYWORDS.has(content.slice(start, k + 1));
	};

	/**
	 * Skips the regex literal starting at `i`: honours `\` escapes and
	 * `[...]` classes, ends at the unescaped `/`, then skips the flags.
	 * Returns `false` (leaving `i` unchanged) when the line ends first: then the
	 * `/` was a division after all.
	 */
	const readRegexLiteral = (): boolean => {
		let k = i + 1;
		let inClass = false;
		while (k < length) {
			const ch = content[k]!;
			if (ch === "\n") return false;
			if (ch === "\\") {
				k += 2;
				continue;
			}
			if (inClass) {
				if (ch === "]") inClass = false;
			} else if (ch === "[") {
				inClass = true;
			} else if (ch === "/") {
				k++;
				while (k < length && /[A-Za-z]/.test(content[k]!)) k++;
				i = k;
				return true;
			}
			k++;
		}
		return false;
	};

	const readTripleQuotedString = (quote: string): void => {
		const marker = quote.repeat(3);
		i += 3;
		while (i < length && !content.startsWith(marker, i)) {
			if (content[i] === "\n") line++;
			i++;
		}
		i = Math.min(i + 3, length);
	};

	const readLineComment = (markerLength: number): void => {
		const startLine = line;
		const start = i;
		commentStarts.push(start);
		i += markerLength;
		while (i < length && content[i] !== "\n") i++;
		comments.push({ line: startLine, text: content.slice(start + markerLength, i).trim() });
	};

	const readBlockComment = (startMarker: string, endMarker: string): void => {
		const startLine = line;
		const start = i;
		commentStarts.push(start);
		i += startMarker.length;
		while (i < length && !content.startsWith(endMarker, i)) {
			if (content[i] === "\n") line++;
			i++;
		}
		const end = i;
		i = Math.min(i + endMarker.length, length);
		comments.push({ line: startLine, text: content.slice(start + startMarker.length, end).trim() });
	};

	while (i < length) {
		const ch = content[i]!;

		if (options.rustLifetimes && ch === "'" && isRustLifetime()) {
			i++;
			continue;
		}

		if (ch === "'" || ch === '"' || (family !== "html" && ch === "`")) {
			if (
				python &&
				(ch === "'" || ch === '"') &&
				content.slice(i, i + 3) === ch.repeat(3)
			) {
				readTripleQuotedString(ch);
			} else {
				readString(ch);
			}
			continue;
		}

		if (
			options.regexLiterals &&
			ch === "/" &&
			content[i + 1] !== "/" &&
			content[i + 1] !== "*" &&
			content[i + 1] !== ">" &&
			regexAllowedHere() &&
			readRegexLiteral()
		) {
			continue;
		}

		let consumed = false;
		switch (family) {
			case "c":
				if (ch === "/" && content[i + 1] === "/") {
					readLineComment(2);
					consumed = true;
				} else if (ch === "/" && content[i + 1] === "*") {
					readBlockComment("/*", "*/");
					consumed = true;
				}
				break;
			case "block":
				if (ch === "/" && content[i + 1] === "*") {
					readBlockComment("/*", "*/");
					consumed = true;
				}
				break;
			case "hash":
				if (ch === "#") {
					readLineComment(1);
					consumed = true;
				}
				break;
			case "dash":
				if (ch === "-" && content[i + 1] === "-") {
					readLineComment(2);
					consumed = true;
				} else if (ch === "/" && content[i + 1] === "*") {
					readBlockComment("/*", "*/");
					consumed = true;
				}
				break;
			case "html":
				if (content.startsWith("<!--", i)) {
					readBlockComment("<!--", "-->");
					consumed = true;
				}
				break;
		}
		if (consumed) continue;

		if (ch === "\n") line++;
		i++;
	}

	if (desync === undefined) return comments;
	// Keep what was scanned before the failing string; the rest of its line
	// is unknown, and later lines only report comments that open a line. A
	// comment opening the desync line starts before the string, so it is
	// already among the kept ones.
	const kept = comments.filter((_, index) => commentStarts[index]! < desync!.offset);
	const nextLineStart = content.indexOf("\n", desync.offset);
	if (nextLineStart < 0) return kept;
	return [...kept, ...extractLineComments(content.slice(nextLineStart + 1), family, desync.line)];
}

// =============================================================================
// Allow list
// =============================================================================

/**
 * Tooling directives that look like comments but change tool behavior:
 * lint suppressions, coverage exclusions, formatter switches. They are not
 * explanations of the code, so they stay allowed.
 */
const TOOLING_DIRECTIVE =
	/^(?:@ts-(?:ignore|expect-error|nocheck|check)|eslint-(?:disable|enable)|biome-ignore|prettier-ignore|stylelint-(?:disable|enable)|noinspection|type:\s*ignore|pylint:\s*(?:disable|enable)|rubocop:(?:disable|enable|todo)|ruff:\s*(?:ignore|noqa)|swiftlint(?::|\s)(?:disable|enable)|deno-lint-(?:ignore|disable)|jshint\s+ignore|istanbul\s+ignore|v8\s+ignore|c8\s+ignore|fmt:\s*(?:on|off)|clang-format\s+(?:on|off)|@formatter:(?:on|off)|ignore(?:_for_file)?\s*:|noqa\b|nolint\b)/i;

function isAllowedComment(comment: SourceComment): boolean {
	// Shebang on the first line (also a hashbang grammar in JavaScript).
	if (comment.line === 1 && comment.text.startsWith("!")) return true;
	if (TOOLING_DIRECTIVE.test(comment.text)) return true;
	// Purely decorative separators (dashes, box characters, whitespace).
	return !/[a-z0-9]/i.test(comment.text);
}

/** Whitespace-normalized identity of a comment, for new-vs-existing comparison. */
function signature(comment: SourceComment): string {
	return comment.text.replace(/\s+/g, " ");
}

function firstNewComment(
	candidates: readonly SourceComment[],
	existingSignatures: ReadonlySet<string>,
): SourceComment | undefined {
	for (const comment of candidates) {
		if (isAllowedComment(comment)) continue;
		if (existingSignatures.has(signature(comment))) continue;
		return comment;
	}
	return undefined;
}

// =============================================================================
// Patch parsing
// =============================================================================

interface PatchedFile {
	path: string;
	addedLines: string[];
	removedLines: string[];
}

const ADD_FILE_HEADER = /^\*\*\* Add File: (.+)$/;
const UPDATE_FILE_HEADER = /^\*\*\* Update File: (.+)$/;
const MOVE_TO_HEADER = /^\*\*\* Move to: (.+)$/;
const SECTION_HEADER = /^\*\*\* /;
const NEW_FILE_DIFF_HEADER = /^\+\+\+\s+(?:[ab]\/)?([^\t\n]+)$/;

function parsePatchSections(patch: string): PatchedFile[] {
	const files: PatchedFile[] = [];
	const lines = patch.split("\n");

	let current: PatchedFile | undefined;
	let mode: "openai-add" | "openai-update" | "openai-move" | "diff" | "skip" | undefined;
	let diffPath: string | undefined;

	for (const line of lines) {
		const addMatch = ADD_FILE_HEADER.exec(line);
		if (addMatch) {
			current = { path: addMatch[1]!, addedLines: [], removedLines: [] };
			files.push(current);
			mode = "openai-add";
			continue;
		}
		const updateMatch = UPDATE_FILE_HEADER.exec(line);
		if (updateMatch) {
			current = { path: updateMatch[1]!, addedLines: [], removedLines: [] };
			files.push(current);
			mode = "openai-update";
			continue;
		}
		const moveMatch = MOVE_TO_HEADER.exec(line);
		if (moveMatch) {
			// A pure rename carries the content over unchanged: nothing new.
			if (current) current.path = moveMatch[1]!;
			mode = "openai-move";
			continue;
		}
		if (SECTION_HEADER.test(line)) {
			// End Patch or any unrecognized directive: stop reading content.
			mode = "skip";
			continue;
		}

		const diffMatch = NEW_FILE_DIFF_HEADER.exec(line);
		if (diffMatch) {
			diffPath = diffMatch[1] === "/dev/null" ? undefined : diffMatch[1];
			if (diffPath) {
				current = { path: diffPath, addedLines: [], removedLines: [] };
				files.push(current);
				mode = "diff";
			} else {
				current = undefined;
				mode = "skip";
			}
			continue;
		}

		if (mode === "openai-add" && current) {
			// Add File bodies prefix every content line with "+".
			current.addedLines.push(line.replace(/^\+/, ""));
			continue;
		}
		if (mode === "openai-update" && current) {
			if (line.startsWith("+")) current.addedLines.push(line.slice(1));
			else if (line.startsWith("-")) current.removedLines.push(line.slice(1));
			continue;
		}
		if (mode === "openai-move" && current) {
			// Renamed-file content lines are moved, not introduced.
			continue;
		}
		if (mode === "diff" && current) {
			if (line.startsWith("+") && !NEW_FILE_DIFF_HEADER.test(line)) {
				current.addedLines.push(line.slice(1));
			} else if (line.startsWith("-") && !/^(?:---)/.test(line)) {
				current.removedLines.push(line.slice(1));
			}
		}
	}

	return files.filter((file) => file.addedLines.length > 0 || file.removedLines.length > 0);
}

// =============================================================================
// Violation detection
// =============================================================================

export interface CommentViolation {
	path: string;
	line: number;
	comment: string;
}

async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function violationInFileText(
	path: string,
	newText: string,
	existingText: string | undefined,
): Promise<CommentViolation | undefined> {
	const family = commentFamilyForPath(path);
	if (!family) return undefined;

	const existing = existingText
		? new Set(commentsForPath(existingText, path).map(signature))
		: new Set<string>();

	const comment = firstNewComment(commentsForPath(newText, path), existing);
	return comment ? { path, line: comment.line, comment: comment.text } : undefined;
}

function violationInAddedText(
	path: string,
	addedLines: readonly string[],
	removedLines: readonly string[],
): CommentViolation | undefined {
	const family = commentFamilyForPath(path);
	if (!family) return undefined;

	const existing = new Set(commentsForPath(removedLines.join("\n") + "\n", path).map(signature));

	const comment = firstNewComment(commentsForPath(addedLines.join("\n") + "\n", path), existing);
	return comment ? { path, line: comment.line, comment: comment.text } : undefined;
}

// ─── Bash write vectors ──────────────────────────────────────────────────────

const WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>"]);
const STDOUT_ECHO_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf"]);

function isLikelyFileDestination(token: string): boolean {
	// File-descriptor duplication (`>&2`) and option-like words are not paths.
	return token.length > 0 && !/^\d+$/.test(token) && !token.startsWith("-");
}

function bashWriteDestinations(segment: readonly string[]): string[] {
	const destinations: string[] = [];

	for (let i = 0; i < segment.length; i++) {
		const token = segment[i]!;
		if (WRITE_REDIRECTS.has(token)) {
			const destination = segment[i + 1];
			if (destination && isLikelyFileDestination(destination)) destinations.push(destination);
			continue;
		}
		if (token === "tee") {
			for (let j = i + 1; j < segment.length; j++) {
				const argument = segment[j]!;
				if (WRITE_REDIRECTS.has(argument)) break;
				if (argument.startsWith("-")) continue;
				if (argument === "<<" || argument === "<<-") break;
				destinations.push(argument);
			}
			continue;
		}
	}

	return destinations;
}

function echoArguments(segment: readonly string[]): string[] {
	const command = segment[0];
	if (command === undefined || !STDOUT_ECHO_COMMANDS.has(command)) return [];

	const arguments_: string[] = [];
	for (let i = 1; i < segment.length; i++) {
		const token = segment[i]!;
		if (token === "<<") break; // a heredoc body carries the real data
		if (WRITE_REDIRECTS.has(token)) {
			i++; // skip the destination word
			continue;
		}
		if (token.startsWith("-")) continue;
		arguments_.push(token);
	}

	return arguments_;
}

async function violationInBashCommand(command: string, cwd: string): Promise<CommentViolation | undefined> {
	const extraction = extractHeredocs(command);
	const commandText = extraction?.text ?? command;
	const bodies = extraction?.bodies ?? [];

	const segments = splitTokensBySeparators(tokenize(commandText));

	for (const segment of segments) {
		const destinations = bashWriteDestinations(segment);
		const sourceDestination = destinations.find(
			(destination) => Boolean(commentFamilyForPath(destination)) && isInsideProject(destination, cwd),
		);
		if (!sourceDestination) continue;

		for (const body of bodies) {
			const comment = firstNewComment(commentsForPath(body, sourceDestination), new Set());
			if (comment) {
				return { path: sourceDestination, line: comment.line, comment: comment.text };
			}
		}

		for (const argument of echoArguments(segment)) {
			const comment = firstNewComment(commentsForPath(argument, sourceDestination), new Set());
			if (comment) {
				return { path: sourceDestination, line: comment.line, comment: comment.text };
			}
		}
	}

	return undefined;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

/**
 * Whether `path` lies inside the project working directory. Files outside it
 * (throwaway scripts under the system temp directory) are not project source,
 * so the comment guard does not apply to them.
 */
function isInsideProject(path: string, cwd: string): boolean {
	const rel = relative(resolve(cwd), resolve(cwd, path));
	if (rel === "") return true;
	return !(rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel));
}

/**
 * Returns the first comment the tool call would introduce into a source
 * file, or `undefined` when the call adds no new comment. Pure renames and
 * tools that do not carry file text are ignored.
 */
export async function findNewSourceComments(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<CommentViolation | undefined> {
	if (toolName === "write") {
		const path = input.path;
		const content = input.content;
		if (typeof path !== "string" || typeof content !== "string") return undefined;
		if (!isInsideProject(path, cwd)) return undefined;
		return violationInFileText(path, content, await readTextIfExists(resolve(cwd, path)));
	}

	if (toolName === "edit") {
		const path = input.path;
		const edits = input.edits;
		if (typeof path !== "string" || !Array.isArray(edits)) return undefined;
		if (!isInsideProject(path, cwd)) return undefined;
		if (commentFamilyForPath(path) === undefined) return undefined;

		for (const edit of edits) {
			if (typeof edit !== "object" || edit === null) continue;
			const oldText = (edit as Record<string, unknown>).oldText;
			const newText = (edit as Record<string, unknown>).newText;
			if (typeof newText !== "string") continue;

			const existing =
				typeof oldText === "string"
					? new Set(commentsForPath(oldText, path).map(signature))
					: new Set<string>();

			const comment = firstNewComment(commentsForPath(newText, path), existing);
			if (comment) return { path, line: comment.line, comment: comment.text };
		}

		return undefined;
	}

	if (toolName.endsWith("apply_patch")) {
		const patch = [input.input, input.patch].find(
			(value): value is string => typeof value === "string",
		);
		if (patch === undefined) return undefined;

		for (const file of parsePatchSections(patch)) {
			if (!isInsideProject(file.path, cwd)) continue;
			const violation = violationInAddedText(file.path, file.addedLines, file.removedLines);
			if (violation) return violation;
		}

		return undefined;
	}

	if (toolName === "bash") {
		const command = input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;
		return violationInBashCommand(command, cwd);
	}

	return undefined;
}

export function sourceCommentBlockReason(violation: CommentViolation): string {
	const preview = violation.comment.replace(/\s+/g, " ").slice(0, 100);
	return (
		`[prevent-destructive-commands] Blocked: ${violation.path}:${violation.line} would introduce a new comment ("${preview}"). ` +
		"Write self-documenting code without comments and move any explanation into the commit message or pull request. " +
		"Only shebang lines and recognized tooling directives (lint suppressions, formatter switches) are exempt."
	);
}
