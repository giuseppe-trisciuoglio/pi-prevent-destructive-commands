import { tokenize } from "../tokenizer";
import { SHELL_OPERATORS } from "../config";
import { isOutsideCwd, resolvePath } from "./path-utils";
import { type CheckResult, SAFE, block } from "./types";
import { tmpdir } from "node:os";

const SYSTEM_TEMP_DIRS: readonly string[] = [tmpdir(), "/tmp"];

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

function isSystemTemp(absPath: string): boolean {
	const normalized = absPath.replace(/\/+$/, "/");
	return SYSTEM_TEMP_DIRS.some((t) => {
		const root = t.replace(/\/+$/, "/");
		return normalized === root || normalized.startsWith(root);
	});
}

export function checkPathInsideWorkdir(
	p: string,
	resolveCwd: string,
	boundaryCwd: string,
): CheckResult {
	const abs = resolvePath(p, resolveCwd);
	if (abs === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	if (isSystemTemp(abs)) {
		return SAFE;
	}
	return isOutsideCwd(p, resolveCwd, boundaryCwd);
}

export function checkCommandWorkdir(command: string, cwd: string): CheckResult {
	const tokens = tokenize(command);
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
		if (token === "(" || token === ")") {
			i++;
			continue;
		}
		if (token === "cd") {
			let j = i + 1;
			let target: string | null = null;
			while (j < tokens.length) {
				const arg = tokens[j];
				if (!arg || SHELL_OPERATORS.has(arg) || arg.startsWith("-")) break;
				target = arg;
				j++;
				break;
			}
			i = j;
			continue;
		}
		if (looksLikePath(token)) {
			const r = checkPathInsideWorkdir(token, cwd, cwd);
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
