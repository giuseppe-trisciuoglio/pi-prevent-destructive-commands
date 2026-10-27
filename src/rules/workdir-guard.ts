import {
	DELEGATION_COMMANDS,
	HEREDOC_EXECUTOR_COMMANDS,
	MAX_NESTING_DEPTH,
	PATH_SENSITIVE_COMMANDS,
	QUOTED_COMMAND_WRAPPERS,
	SHELL_COMMANDS,
	SHELL_OPERATORS,
	WRITE_REDIRECT_OPERATORS,
} from "../config";
import { extractHeredocs } from "../heredoc";
import { tokenize } from "../tokenizer";
import { forEachPositionalArg } from "./args";
import { hasGlobMagic, hasShellVariable } from "./glob";
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
]);

const WRITE_TARGET_LAST_ARG_COMMANDS: ReadonlySet<string> = new Set([
	"cp",
	"mv",
	"install",
	"ln",
]);

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
	if (!p.endsWith("/") && isSystemTempRoot(resolved)) {
		return block(
			`${JSON.stringify(p)} targets the system temp directory root itself — temp files are allowed, the temp root is not`,
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
} {
	const writeTargets = new Set<number>();
	const redirectTargets = new Set<number>();

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

	return { writeTargets, redirectTargets };
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

	const { writeTargets, redirectTargets } = collectWriteTargetIndices(tokens);
	const cwdStack: string[] = [];
	let currentCwd = cwd;

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token) {
			i++;
			continue;
		}

		if (token === "(") {
			cwdStack.push(currentCwd);
			i++;
			continue;
		}
		if (token === ")") {
			currentCwd = cwdStack.pop() ?? cwd;
			i++;
			continue;
		}

		if (SHELL_OPERATORS.has(token)) {
			i++;
			continue;
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
			currentCwd = resolvePath(target, currentCwd) ?? currentCwd;
			i = j;
			continue;
		}

		if (SHELL_COMMANDS.has(token)) {
			let j = i + 1;
			while (j < tokens.length) {
				if (tokens[j] === "-c" && j + 1 < tokens.length) {
					const r = checkCommandWorkdir(tokens[j + 1]!, currentCwd, depth + 1);
					if (r.dangerous) return r;
					break;
				}
				if (tokens[j]!.startsWith("-")) {
					j++;
					continue;
				}
				break;
			}
			i++;
			continue;
		}

		if (QUOTED_COMMAND_WRAPPERS.has(token)) {
			let dangerous: CheckResult | undefined;
			forEachPositionalArg(tokens, i, (arg) => {
				const r = checkCommandWorkdir(arg, currentCwd, depth + 1);
				if (r.dangerous) {
					dangerous = r;
					return false;
				}
			});
			if (dangerous) return dangerous;
			i++;
			continue;
		}

		if (DELEGATION_COMMANDS.has(token)) {
			if (i + 1 < tokens.length) {
				const r = checkCommandTokens(tokens.slice(i + 1), currentCwd, depth + 1, boundaryCwd);
				if (r.dangerous) return r;
			}
			i++;
			continue;
		}

		if (/\s/.test(token) && token.includes("/")) {
			const r = checkCommandWorkdir(token, currentCwd, depth + 1);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (looksLikePath(token)) {
			const access: WorkdirAccess = redirectTargets.has(i)
				? "redirect"
				: writeTargets.has(i)
					? "write"
					: "read";
			const r = checkPathInsideWorkdir(token, currentCwd, boundaryCwd, access);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		i++;
	}

	return SAFE;
}

export function checkCommandWorkdir(command: string, cwd: string, depth = 0): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"command nesting too deep to safely analyze (possible obfuscation)",
		);
	}

	const extraction = extractHeredocs(command);
	if (extraction === null) {
		return checkCommandTokens(tokenize(command), cwd, depth, cwd);
	}

	const lineTokens = tokenize(extraction.text);
	const result = checkCommandTokens(lineTokens, cwd, depth, cwd);
	if (result.dangerous) return result;

	if (extraction.bodies.length > 0 && lineTokens.some((t) => HEREDOC_EXECUTOR_COMMANDS.has(t))) {
		for (const body of extraction.bodies) {
			const r = checkCommandWorkdir(body, cwd, depth + 1);
			if (r.dangerous) return r;
		}
	}

	return result;
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
