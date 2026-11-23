import {
	analyzeHeredocCommand,
	checkQuotedCommandWrapper,
	classifySedOperands,
	createCommandTokenCursor,
	shellCommandScript,
} from "../command-analysis";
import {
	DELEGATION_COMMANDS,
	MAX_NESTING_DEPTH,
	PATH_SENSITIVE_COMMANDS,
	QUOTED_COMMAND_WRAPPERS,
	SHELL_COMMANDS,
	SHELL_OPERATORS,
	WRITE_REDIRECT_OPERATORS,
} from "../config";
import { hasGlobMagic, hasShellVariable } from "./glob";
import { classifyProgramOperands, extractProgramLiterals, type ProgramLanguage } from "./program-operands";
import { isOutsideCwd, isSkillPath, isSystemTempRoot, type PathAccess, resolvePath } from "./path-utils";
import { type CheckResult, SAFE, block } from "./types";

export type WorkdirAccess = PathAccess;

const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "find", "ls"]);

const WRITE_TARGET_ALL_ARGS_COMMANDS: ReadonlySet<string> = new Set([
	"tee",
	"truncate",
	"chmod",
	"chown",
	"chgrp",
	"mv",
]);

const WRITE_TARGET_LAST_ARG_COMMANDS: ReadonlySet<string> = new Set([
	"cp",
	"install",
	"ln",
]);

const OUTPUT_OPTION_FLAGS: ReadonlySet<string> = new Set([
	"-o",
	"-O",
	"--output",
	"--output-document",
]);

const OUTPUT_LONG_OPTIONS: ReadonlySet<string> = new Set(["--output", "--output-document"]);

const FREE_TEXT_LONG_OPTIONS: ReadonlySet<string> = new Set([
	"--title",
	"--body",
	"--message",
	"--subject",
	"--description",
	"--notes",
	"--grep",
	"--format",
	"--pretty",
	"--author",
	"--committer",
	"--label",
]);

function parseLongOptionValue(token: string): { name: string; value: string } | null {
	const match = /^(--[A-Za-z0-9][A-Za-z0-9-]*)=(.*)$/s.exec(token);
	if (!match) return null;
	return { name: match[1]!, value: match[2]! };
}

const GIT_MESSAGE_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"commit",
	"tag",
	"merge",
	"notes",
	"stash",
]);

const GIT_MESSAGE_VALUE_PREFIXES: readonly string[] = ["--message=", "--notes="];
const GIT_MESSAGE_VALUE_FLAGS: ReadonlySet<string> = new Set(["--message", "--notes"]);

function collectGitMessageIndices(tokens: string[]): Set<number> {
	const skip = new Set<number>();
	let gitSubcommand: string | null = null;
	let seenGit = false;
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (SHELL_OPERATORS.has(token)) {
			seenGit = false;
			gitSubcommand = null;
			continue;
		}
		if (!seenGit) {
			if (token === "git") seenGit = true;
			continue;
		}
		if (gitSubcommand === null) {
			if (!token.startsWith("-")) gitSubcommand = token;
			continue;
		}
		if (!GIT_MESSAGE_SUBCOMMANDS.has(gitSubcommand)) continue;
		if (token === "-m" || GIT_MESSAGE_VALUE_FLAGS.has(token)) {
			if (i + 1 < tokens.length) skip.add(i + 1);
			continue;
		}
		if (/^-[a-zA-Z]+m$/.test(token)) {
			if (i + 1 < tokens.length) skip.add(i + 1);
			continue;
		}
		for (const prefix of GIT_MESSAGE_VALUE_PREFIXES) {
			if (token === prefix) {
				if (i + 1 < tokens.length) skip.add(i + 1);
				break;
			}
			if (token.startsWith(prefix)) {
				skip.add(i);
				break;
			}
		}
	}
	return skip;
}

/**
 * API clients whose endpoint argument is a URL or API path, never a
 * filesystem path. Each entry describes how to locate the endpoint token.
 * Flags listed in `valueFlags` consume the following token; any other flag is
 * treated as boolean. Real file arguments (`--input <file>`, `@file` request
 * items) stay subject to the workdir guard.
 */
interface ApiClientSpec {
	/** Subcommand that must follow the client (e.g. `api`), or null. */
	subcommand: string | null;
	/** Whether an HTTP method positional precedes the endpoint. */
	method: "none" | "optional" | "required";
	valueFlags: ReadonlySet<string>;
	/** Flags whose value is a `key=@file` field that reads a file. */
	atFileFlags: ReadonlySet<string>;
	/** Whether positional request items after the endpoint may embed `@file`. */
	atFileItems: boolean;
}

const HTTP_METHOD_PATTERN = /^[A-Za-z]+$/;

/** `gh api` flags that take a separate value. */
export const GH_API_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"-X",
	"--method",
	"-H",
	"--header",
	"-f",
	"--raw-field",
	"-F",
	"--field",
	"--input",
	"-q",
	"--jq",
	"-t",
	"--template",
	"--cache",
	"-p",
	"--preview",
	"--hostname",
]);

const GH_API_SPEC: ApiClientSpec = {
	subcommand: "api",
	method: "none",
	valueFlags: GH_API_VALUE_FLAGS,
	atFileFlags: new Set(["-F", "--field"]),
	atFileItems: false,
};

const SONAR_API_SPEC: ApiClientSpec = {
	subcommand: "api",
	method: "required",
	valueFlags: new Set(),
	atFileFlags: new Set(),
	atFileItems: false,
};

/** HTTPie / xh flags that take a separate value. */
export const HTTPIE_VALUE_FLAGS: ReadonlySet<string> = new Set([
	"-a",
	"--auth",
	"-A",
	"--auth-type",
	"--session",
	"--session-read-only",
	"-o",
	"--output",
	"--verify",
	"--cert",
	"--cert-key",
	"--cert-key-pass",
	"--proxy",
	"--timeout",
	"-p",
	"--print",
	"-P",
	"--history-print",
	"--pretty",
	"-s",
	"--style",
	"--format-options",
	"--max-redirects",
	"--boundary",
	"--raw",
	"--default-scheme",
	"--response-charset",
	"--response-mime",
	"--ssl",
	"--ciphers",
	"--unix-socket",
	"--bearer",
]);

const HTTPIE_SPEC: ApiClientSpec = {
	subcommand: null,
	method: "optional",
	valueFlags: HTTPIE_VALUE_FLAGS,
	atFileFlags: new Set(),
	atFileItems: true,
};

const API_CLIENTS: ReadonlyMap<string, ApiClientSpec> = new Map([
	["gh", GH_API_SPEC],
	["sonar", SONAR_API_SPEC],
	["http", HTTPIE_SPEC],
	["https", HTTPIE_SPEC],
	["xh", HTTPIE_SPEC],
	["xhs", HTTPIE_SPEC],
]);

const ASSIGNMENT_PREFIX = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const VARIABLE_REFERENCE = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;

/** Returns the file path embedded in a `key=@file` / `key@file` item, if any. */
function atFilePath(item: string): string | null {
	const match = /(:=@|=@|==|:=|=|:|@)/.exec(item);
	if (!match) return null;
	const separator = match[1]!;
	if (separator !== "=@" && separator !== ":=@" && separator !== "@") return null;
	const path = item.slice(match.index + separator.length);
	return path || null;
}

export interface ApiEndpointAnalysis {
	/** Token indices that are API endpoints (or variable values feeding one). */
	endpointIndices: Set<number>;
	/** Token index → file path read via an `@file` field or request item. */
	atFilePaths: Map<number, string>;
}

/**
 * Locates the endpoint argument of API clients (`gh api`, `sonar api`,
 * HTTPie/xh) so the workdir guard does not mistake `/repos/o/r` or
 * `/api/ce/activity` for a filesystem path. Variable assignments whose
 * variable is referenced only through an endpoint are exempted too.
 */
export function collectApiEndpointIndices(tokens: string[]): ApiEndpointAnalysis {
	const endpointIndices = new Set<number>();
	const atFilePaths = new Map<number, string>();
	const assignments = new Map<string, number>();
	let i = 0;
	while (i < tokens.length) {
		// Skip leading variable assignments, remembering where their values live.
		while (i < tokens.length) {
			const match = ASSIGNMENT_PREFIX.exec(tokens[i]!);
			if (!match) break;
			if (tokens[i] === `${match[1]}=`) {
				const next = tokens[i + 1];
				if (next !== undefined && !SHELL_OPERATORS.has(next)) {
					assignments.set(match[1]!, i + 1);
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			assignments.set(match[1]!, i);
			i++;
		}
		const command = tokens[i];
		if (command !== undefined && SHELL_OPERATORS.has(command)) {
			i++;
			continue;
		}
		const spec = command === undefined ? undefined : API_CLIENTS.get(command);
		let j = i + 1;
		if (spec && (spec.subcommand === null || tokens[j] === spec.subcommand)) {
			if (spec.subcommand !== null) j++;
			const argsStart = j;
			const positionals: number[] = [];
			for (; j < tokens.length; j++) {
				const token = tokens[j]!;
				if (SHELL_OPERATORS.has(token)) break;
				if (token.startsWith("-") && token !== "-") {
					if (spec.valueFlags.has(token)) {
						const value = tokens[j + 1];
						if (value !== undefined && spec.atFileFlags.has(token)) {
							const path = atFilePath(value);
							if (path !== null) atFilePaths.set(j + 1, path);
						}
						j++;
					}
					continue;
				}
				positionals.push(j);
			}
			let endpointPosition = 0;
			if (spec.method === "required") {
				// Strict form: `<client> api <METHOD> <endpoint>` with nothing in between,
				// so an unknown flag's value is never mistaken for the endpoint.
				const first = positionals[0];
				const strict =
					first === argsStart &&
					positionals[1] === first + 1 &&
					HTTP_METHOD_PATTERN.test(tokens[first]!);
				endpointPosition = strict ? 1 : -1;
			} else if (
				spec.method === "optional" &&
				positionals.length > 1 &&
				HTTP_METHOD_PATTERN.test(tokens[positionals[0]!]!)
			) {
				endpointPosition = 1;
			}
			const endpoint = endpointPosition >= 0 ? positionals[endpointPosition] : undefined;
			if (endpoint !== undefined) {
				const token = tokens[endpoint]!;
				if (!token.includes("$(") && !token.includes("`")) {
					endpointIndices.add(endpoint);
					for (const reference of token.matchAll(VARIABLE_REFERENCE)) {
						const valueIndex = assignments.get(reference[1]!);
						if (valueIndex !== undefined) endpointIndices.add(valueIndex);
					}
				}
				if (spec.atFileItems) {
					for (const index of positionals.slice(endpointPosition + 1)) {
						const path = atFilePath(tokens[index]!);
						if (path !== null) atFilePaths.set(index, path);
					}
				}
			}
		}
		// Advance to the next command segment.
		while (j < tokens.length && !SHELL_OPERATORS.has(tokens[j]!)) j++;
		i = j + 1;
	}
	return { endpointIndices, atFilePaths };
}

export function isWriteTool(toolName: string): boolean {
	if (toolName === "write" || toolName === "edit") return true;
	if (toolName.endsWith("apply_patch")) return true;
	if (READ_ONLY_TOOL_NAMES.has(toolName)) return false;
	return true;
}

function looksLikePath(token: string): boolean {
	if (!token) return false;
	if (SHELL_OPERATORS.has(token)) return false;
	if (token.startsWith("-")) return false;
	if (token === "(" || token === ")" || token === "{}" || token === "." || token === "..") return true;
	if (token.includes("/")) return true;
	if (token.startsWith("~")) return true;
	if (token.startsWith("./") || token.startsWith("../")) return true;
	return false;
}

export function checkPathInsideWorkdir(
	p: string,
	resolveCwd: string,
	boundaryCwd: string,
	access: WorkdirAccess = "read",
): CheckResult {
	if (hasShellVariable(p)) {
		return block(
			`path contains a variable that cannot be resolved statically: ${JSON.stringify(p)}`,
		);
	}
	if (hasGlobMagic(p)) {
		return isOutsideCwd(p, resolveCwd, boundaryCwd, access);
	}
	const resolved = resolvePath(p, resolveCwd);
	if (resolved === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	if (access !== "read" && !p.endsWith("/") && isSystemTempRoot(resolved)) {
		return block(
			`${JSON.stringify(p)} targets the system temp directory root itself — temp files are allowed, writing to the temp root is not`,
		);
	}
	if (isSkillPath(resolved)) {
		if (access !== "read") {
			return block(
				`${JSON.stringify(p)} is inside an installed skills directory (${resolved}) — skills are read-only for the agent`,
			);
		}
		return SAFE;
	}
	return isOutsideCwd(p, resolveCwd, boundaryCwd, access);
}

function addPositionals(
	tokens: string[],
	start: number,
	indices: Set<number>,
	mode: "all" | "last",
): void {
	let last = -1;
	for (let j = start; j < tokens.length; j++) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg.startsWith("-")) continue;
		if (mode === "all") indices.add(j);
		else last = j;
	}
	if (mode === "last" && last >= 0) indices.add(last);
}

function collectWriteTargetIndices(tokens: string[]): {
	writeTargets: Set<number>;
	redirectTargets: Set<number>;
	outputOptionTargets: Set<number>;
} {
	const writeTargets = new Set<number>();
	const redirectTargets = new Set<number>();
	const outputOptionTargets = new Set<number>();

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;

		if (WRITE_REDIRECT_OPERATORS.has(token)) {
			const next = tokens[i + 1];
			if (next && !SHELL_OPERATORS.has(next)) {
				writeTargets.add(i + 1);
				redirectTargets.add(i + 1);
			}
			continue;
		}

		if (OUTPUT_OPTION_FLAGS.has(token)) {
			const next = tokens[i + 1];
			if (next && !SHELL_OPERATORS.has(next)) outputOptionTargets.add(i + 1);
			continue;
		}

		if (PATH_SENSITIVE_COMMANDS.has(token)) {
			addPositionals(tokens, i + 1, writeTargets, "all");
			continue;
		}

		if (token === "dd") {
			for (let j = i + 1; j < tokens.length; j++) {
				const arg = tokens[j]!;
				if (SHELL_OPERATORS.has(arg)) break;
				if (arg.startsWith("of=")) writeTargets.add(j);
			}
			continue;
		}

		if (WRITE_TARGET_ALL_ARGS_COMMANDS.has(token)) {
			addPositionals(tokens, i + 1, writeTargets, "all");
			continue;
		}

		if (WRITE_TARGET_LAST_ARG_COMMANDS.has(token)) {
			addPositionals(tokens, i + 1, writeTargets, "last");
			continue;
		}
	}

	return { writeTargets, redirectTargets, outputOptionTargets };
}

/** The program text of a token, without an attached option prefix (`--eval=`, `-e`). */
function programText(token: string): string {
	const long = /^--[A-Za-z-]+=/.exec(token);
	if (long) return token.slice(long[0].length);
	const short = /^-[A-Za-z]*[A-Za-z]/.exec(token);
	if (token.startsWith("-") && short) return token.slice(short[0].length);
	return token;
}

/** A well-formed HTML/XML tag: the name is followed by whitespace, `>` or `/>`, so `</etc/passwd>` is not one. */
const MARKUP_TAG = /<\/?[A-Za-z][\w:-]*(?:\s+[^<>]*?)?\/?>/g;

/**
 * Replaces each well-formed tag by its attribute values (names and quotes
 * removed), so `<script src="a.js"></script>` becomes ` a.js  ` and its
 * closing tag is not read as a redirect from `/script`. Everything outside
 * tags, and every attribute value, stays visible to the normal analysis.
 */
function neutraliseMarkup(literal: string): string {
	return literal.replace(MARKUP_TAG, (tag) => {
		const attrs = tag.replace(/^<\/?[A-Za-z][\w:-]*/, "").replace(/\/?>$/, "");
		return ` ${attrs.replace(/[\w:-]+=/g, " ").replace(/["']/g, " ")} `;
	});
}

/**
 * Checks one string literal of an inline program: literals holding a shell
 * command line (whitespace and a `/`) are analyzed as commands, other
 * path-like literals as paths. URLs are skipped.
 */
function checkProgramLiteral(literal: string, cwd: string, boundaryCwd: string, depth: number): CheckResult {
	if (literal.includes("://")) return SAFE;
	literal = neutraliseMarkup(literal);
	if (/\s/.test(literal) && literal.includes("/")) return checkCommandWorkdir(literal, cwd, depth + 1);
	if (looksLikePath(literal)) return checkPathInsideWorkdir(literal, cwd, boundaryCwd, "read");
	return SAFE;
}

function checkCommandTokens(
	tokens: string[],
	cwd: string,
	depth: number,
	boundaryCwd: string,
): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"command nesting too deep to safely analyze (possible obfuscation)",
		);
	}

	const { writeTargets, redirectTargets, outputOptionTargets } = collectWriteTargetIndices(tokens);
	const gitMessageIndices = collectGitMessageIndices(tokens);
	const { endpointIndices, atFilePaths } = collectApiEndpointIndices(tokens);
	const nonFileScriptIndices = new Set<number>();
	const patternIndices = new Set<number>();
	const programIndices = new Map<number, ProgramLanguage>();
	const cursor = createCommandTokenCursor(tokens, cwd);

	for (const { token, index: i, currentCwd, startsCommand } of cursor) {
		if (startsCommand) {
			const operands = classifyProgramOperands(tokens, i);
			if (operands !== null) {
				for (const index of operands.patternIndices) patternIndices.add(index);
				for (const [index, language] of operands.programIndices) programIndices.set(index, language);
			}
		}

		if (patternIndices.has(i)) continue;

		const language = programIndices.get(i);
		if (language !== undefined) {
			const literals = extractProgramLiterals(programText(token), language);
			if (literals !== null) {
				for (const literal of literals) {
					const r = checkProgramLiteral(literal, currentCwd, boundaryCwd, depth);
					if (r.dangerous) return r;
				}
				continue;
			}
			// Unparseable program: fall through to the generic token analysis.
		}

		if (startsCommand && token === "sed") {
			const operands = classifySedOperands(tokens, i);
			if (operands.unsafeInlineScript) {
				return block(
					"sed script contains operations that cannot be verified against the working directory",
				);
			}
			for (const index of operands.nonFileScriptIndices) {
				nonFileScriptIndices.add(index);
			}
			for (const path of operands.scriptFilePaths) {
				const result = checkPathInsideWorkdir(path, currentCwd, boundaryCwd, "read");
				if (result.dangerous) return result;
			}
		}

		if (token === "cd") {
			let j = i + 1;
			let target: string | null = null;
			while (j < tokens.length) {
				const arg = tokens[j];
				if (!arg || SHELL_OPERATORS.has(arg)) break;
				if (arg === "-") {
					return block(`"cd -" changes to a directory that cannot be statically resolved`);
				}
				if (arg.startsWith("-")) {
					j++;
					continue;
				}
				target = arg;
				j++;
				break;
			}
			if (target === null) {
				return block(`"cd" without a target moves to the home directory, outside the working directory`);
			}
			const inside = checkPathInsideWorkdir(target, currentCwd, boundaryCwd, "read");
			if (inside.dangerous) {
				return block(`"cd" leaves the working directory — ${inside.reason}`);
			}
			cursor.setCurrentCwd(resolvePath(target, currentCwd) ?? currentCwd);
			cursor.skipTo(j);
			continue;
		}

		if (SHELL_COMMANDS.has(token)) {
			const script = shellCommandScript(tokens, i);
			if (script !== undefined) {
				const result = checkCommandWorkdir(script, currentCwd, depth + 1);
				if (result.dangerous) return result;
			}
			continue;
		}

		if (QUOTED_COMMAND_WRAPPERS.has(token)) {
			const result = checkQuotedCommandWrapper(
				tokens,
				i,
				currentCwd,
				depth,
				(command, nestedCwd, nestedDepth) => checkCommandWorkdir(command, nestedCwd, nestedDepth),
			);
			if (result.dangerous) return result;
			continue;
		}

		if (DELEGATION_COMMANDS.has(token)) {
			if (i + 1 < tokens.length) {
				const r = checkCommandTokens(tokens.slice(i + 1), currentCwd, depth + 1, boundaryCwd);
				if (r.dangerous) return r;
			}
			continue;
		}

		if (nonFileScriptIndices.has(i)) continue;

		if (gitMessageIndices.has(i)) continue;

		if (endpointIndices.has(i)) continue;

		const atFile = atFilePaths.get(i);
		if (atFile !== undefined) {
			const r = checkPathInsideWorkdir(atFile, currentCwd, boundaryCwd, "read");
			if (r.dangerous) return r;
			continue;
		}

		if (token.startsWith("--template=")) {
			const templatePath = token.slice("--template=".length);
			if (templatePath) {
				const r = checkPathInsideWorkdir(templatePath, currentCwd, boundaryCwd, "read");
				if (r.dangerous) return r;
			}
			continue;
		}

		const longOption = parseLongOptionValue(token);
		if (longOption) {
			const { name, value } = longOption;
			if (FREE_TEXT_LONG_OPTIONS.has(name) || value.includes("://")) continue;
			if (looksLikePath(value)) {
				const access: WorkdirAccess = OUTPUT_LONG_OPTIONS.has(name) ? "redirect" : "read";
				const r = checkPathInsideWorkdir(value, currentCwd, boundaryCwd, access);
				if (r.dangerous) return r;
			}
			continue;
		}

		if (/\s/.test(token) && token.includes("/")) {
			const r = checkCommandWorkdir(token, currentCwd, depth + 1);
			if (r.dangerous) return r;
			continue;
		}

		if (looksLikePath(token)) {
			const isDiscardSink =
				redirectTargets.has(i) || (outputOptionTargets.has(i) && !writeTargets.has(i));
			const access: WorkdirAccess = isDiscardSink
				? "redirect"
				: writeTargets.has(i)
					? "write"
					: "read";
			const r = checkPathInsideWorkdir(token, currentCwd, boundaryCwd, access);
			if (r.dangerous) return r;
			continue;
		}
	}

	return SAFE;
}

export function checkCommandWorkdir(command: string, cwd: string, depth = 0): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"command nesting too deep to safely analyze (possible obfuscation)",
		);
	}

	return analyzeHeredocCommand(
		command,
		(tokens) => checkCommandTokens(tokens, cwd, depth, cwd),
		(body) => checkCommandWorkdir(body, cwd, depth + 1),
	);
}

export function checkToolInputWorkdir(
	toolName: string,
	input: Record<string, unknown>,
	extractPaths: (patch: string) => string[],
	boundaryCwd: string,
	extraPaths: string[] = [],
): CheckResult {
	const paths = [...extraPaths];

	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string") {
		paths.push(input.path);
	}

	if (toolName.endsWith("apply_patch")) {
		const patchValues = [input.input, input.patch].filter(
			(v): v is string => typeof v === "string",
		);
		for (const pv of patchValues) {
			paths.push(...extractPaths(pv));
		}
	}

	const access: WorkdirAccess = isWriteTool(toolName) ? "write" : "read";

	for (const p of paths) {
		const r = checkPathInsideWorkdir(p, boundaryCwd, boundaryCwd, access);
		if (r.dangerous) return r;
	}
	return SAFE;
}
