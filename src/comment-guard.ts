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
import { basename, extname, resolve } from "node:path";
import { extractHeredocs } from "./heredoc";
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

// =============================================================================
// Comment extraction
// =============================================================================

export interface SourceComment {
	/** Line where the comment starts, relative to the scanned text. */
	line: number;
	/** Inner text without comment markers, trimmed. */
	text: string;
}

/**
 * Extracts every comment from `content`, skipping string and template
 * literals so markers inside them (an URL like "https://…" inside quotes)
 * are not mistaken for comments. Python triple-quoted strings are skipped
 * for Python files.
 */
export function extractComments(
	content: string,
	family: CommentFamily,
	python = false,
): SourceComment[] {
	const comments: SourceComment[] = [];
	const length = content.length;
	let line = 1;
	let i = 0;

	const readString = (quote: string): void => {
		i++; // opening quote
		while (i < length) {
			const ch = content[i]!;
			if (ch === "\\" && i + 1 < length) {
				i += 2;
				continue;
			}
			i++;
			if (ch === quote) return;
			if (ch === "\n") line++;
		}
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
		i += markerLength;
		while (i < length && content[i] !== "\n") i++;
		comments.push({ line: startLine, text: content.slice(start + markerLength, i).trim() });
	};

	const readBlockComment = (startMarker: string, endMarker: string): void => {
		const startLine = line;
		const start = i;
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

	return comments;
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

	const python = isPythonPath(path);
	const existing = existingText
		? new Set(extractComments(existingText, family, python).map(signature))
		: new Set<string>();

	const comment = firstNewComment(extractComments(newText, family, python), existing);
	return comment ? { path, line: comment.line, comment: comment.text } : undefined;
}

function violationInAddedText(
	path: string,
	addedLines: readonly string[],
	removedLines: readonly string[],
): CommentViolation | undefined {
	const family = commentFamilyForPath(path);
	if (!family) return undefined;

	const python = isPythonPath(path);
	const existing = new Set(
		extractComments(removedLines.join("\n") + "\n", family, python).map(signature),
	);

	const comment = firstNewComment(
		extractComments(addedLines.join("\n") + "\n", family, python),
		existing,
	);
	return comment ? { path, line: comment.line, comment: comment.text } : undefined;
}

// ─── Bash write vectors ──────────────────────────────────────────────────────

const COMMAND_SEPARATORS: ReadonlySet<string> = new Set(["|", ";", "&&", "||", "&", "(", ")"]);
const WRITE_REDIRECTS: ReadonlySet<string> = new Set([">", ">>"]);
const STDOUT_ECHO_COMMANDS: ReadonlySet<string> = new Set(["echo", "printf"]);

function splitIntoSegments(tokens: readonly string[]): string[][] {
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

	const segments = splitIntoSegments(tokenize(commandText));

	for (const segment of segments) {
		const destinations = bashWriteDestinations(segment);
		const sourceDestination = destinations.find((destination) =>
			Boolean(commentFamilyForPath(destination)),
		);
		if (!sourceDestination) continue;

		const family = commentFamilyForPath(sourceDestination)!;
		const python = isPythonPath(sourceDestination);

		for (const body of bodies) {
			const comment = firstNewComment(extractComments(body, family, python), new Set());
			if (comment) {
				return { path: sourceDestination, line: comment.line, comment: comment.text };
			}
		}

		for (const argument of echoArguments(segment)) {
			const comment = firstNewComment(extractComments(argument, family, python), new Set());
			if (comment) {
				return { path: sourceDestination, line: comment.line, comment: comment.text };
			}
		}
	}

	return undefined;
}

// ─── Entry point ─────────────────────────────────────────────────────────────

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
		return violationInFileText(path, content, await readTextIfExists(resolve(cwd, path)));
	}

	if (toolName === "edit") {
		const path = input.path;
		const edits = input.edits;
		if (typeof path !== "string" || !Array.isArray(edits)) return undefined;
		if (commentFamilyForPath(path) === undefined) return undefined;

		for (const edit of edits) {
			if (typeof edit !== "object" || edit === null) continue;
			const oldText = (edit as Record<string, unknown>).oldText;
			const newText = (edit as Record<string, unknown>).newText;
			if (typeof newText !== "string") continue;

			const existing =
				typeof oldText === "string"
					? new Set(extractComments(oldText, commentFamilyForPath(path)!, isPythonPath(path)).map(signature))
					: new Set<string>();

			const comment = firstNewComment(
				extractComments(newText, commentFamilyForPath(path)!, isPythonPath(path)),
				existing,
			);
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
