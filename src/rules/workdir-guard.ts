import { SHELL_OPERATORS } from "../config";
import { tokenize } from "../tokenizer";
import { isOutsideCwd, isSystemTempRoot, resolvePath } from "./path-utils";
import { type CheckResult, SAFE, block } from "./types";

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
): CheckResult {
	const resolved = resolvePath(p, resolveCwd);
	if (resolved === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	if (!p.endsWith("/") && isSystemTempRoot(resolved)) {
		return block(
			`${JSON.stringify(p)} targets the system temp directory root itself — temp files are allowed, the temp root is not`,
		);
	}
	return isOutsideCwd(p, resolveCwd, boundaryCwd);
}

export function checkCommandWorkdir(command: string, cwd: string): CheckResult {
	const tokens = tokenize(command);
	const cwdStack: string[] = [];
	let currentCwd = cwd;

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];
		if (!token) {
			i++;
			continue;
		}
		if (SHELL_OPERATORS.has(token) || token.startsWith("-")) {
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
		if (token === "cd") {
			let j = i + 1;
			let target: string | null = null;
			while (j < tokens.length) {
				const arg = tokens[j];
				if (!arg || SHELL_OPERATORS.has(arg)) break;
				if (arg === "-") {
					return block(`\"cd -\" changes to a directory that cannot be statically resolved`);
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
				return block(`\"cd\" without a target moves to the home directory, outside the working directory`);
			}
			const inside = checkPathInsideWorkdir(target, currentCwd, cwd);
			if (inside.dangerous) {
				return block(`\"cd\" leaves the working directory — ${inside.reason}`);
			}
			currentCwd = resolvePath(target, currentCwd) ?? currentCwd;
			i = j;
			continue;
		}
		if (looksLikePath(token)) {
			const r = checkPathInsideWorkdir(token, currentCwd, cwd);
			if (r.dangerous) return r;
		}
		i++;
	}
	return SAFE;
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

	for (const p of paths) {
		const r = checkPathInsideWorkdir(p, boundaryCwd, boundaryCwd);
		if (r.dangerous) return r;
	}
	return SAFE;
}
