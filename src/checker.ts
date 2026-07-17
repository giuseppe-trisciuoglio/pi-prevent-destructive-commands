/**
 * Recursive destructive command analyzer.
 *
 * Port of Claude's `_check_tokens`. Visits the token list recognizing wrappers,
 * shell invocations, `find -exec`, `xargs`, and dangerous commands (git, docker,
 * aws, path-sensitive, sensitive file reads). Returns the first block reason found.
 *
 * The per-category rule handlers live in `./rules/`.
 */

import { tokenize } from "./tokenizer";
import {
	DELEGATION_COMMANDS,
	FILE_READING_COMMANDS,
	FIND_EXEC_FLAGS,
	MAX_NESTING_DEPTH,
	PATH_SENSITIVE_COMMANDS,
	QUOTED_COMMAND_WRAPPERS,
	SHELL_COMMANDS,
	SHELL_OPERATORS,
	WRAPPER_COMMANDS,
} from "./config";
import { checkAws } from "./rules/aws";
import { checkDocker } from "./rules/docker";
import { checkFileReading } from "./rules/file-reading";
import { checkGit } from "./rules/git";
import { checkPathSensitive } from "./rules/path-sensitive";
import { type CheckResult, SAFE, block } from "./rules/types";

export type { CheckResult };

export function checkTokens(tokens: string[], cwd: string, depth = 0): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"command nesting too deep to safely analyze (possible obfuscation)",
		);
	}

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];

		if (!token || SHELL_OPERATORS.has(token)) {
			i++;
			continue;
		}

		// Wrapper commands: sudo rm, env -i rm, timeout 10 rm, …
		if (WRAPPER_COMMANDS.has(token)) {
			i++;
			continue;
		}

		// Quoted-command wrappers: the first positional argument is a command
		if (QUOTED_COMMAND_WRAPPERS.has(token)) {
			let j = i + 1;
			while (j < tokens.length) {
				const arg = tokens[j];
				if (!arg || SHELL_OPERATORS.has(arg)) break;
				if (arg.startsWith("-")) {
					j++;
					continue;
				}
				const r = checkTokens(tokenize(arg), cwd, depth + 1);
				if (r.dangerous) return r;
				break;
			}
			i++;
			continue;
		}

		// Shell invocations: bash -c "..."
		if (SHELL_COMMANDS.has(token)) {
			let j = i + 1;
			while (j < tokens.length) {
				if (tokens[j] === "-c" && j + 1 < tokens.length) {
					const r = checkTokens(tokenize(tokens[j + 1]), cwd, depth + 1);
					if (r.dangerous) return r;
					break;
				}
				if (tokens[j].startsWith("-")) {
					j++;
				} else {
					break;
				}
			}
			i++;
			continue;
		}

		// find -exec rm {} \;
		if (token === "find") {
			let j = i + 1;
			while (j < tokens.length) {
				if (FIND_EXEC_FLAGS.has(tokens[j]) && j + 1 < tokens.length) {
					let end = j + 2;
					while (end < tokens.length && !["\\;", "+", ";"].includes(tokens[end])) {
						end++;
					}
					const r = checkTokens(tokens.slice(j + 1, end), cwd, depth + 1);
					if (r.dangerous) return r;
				}
				j++;
			}
			i++;
			continue;
		}

		// xargs / parallel: delegate the following command
		if (DELEGATION_COMMANDS.has(token)) {
			if (i + 1 < tokens.length) {
				const r = checkTokens(tokens.slice(i + 1), cwd, depth + 1);
				if (r.dangerous) return r;
			}
			i++;
			continue;
		}

		if (token === "aws") {
			const r = checkAws(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (token === "docker") {
			const r = checkDocker(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (token === "git") {
			const r = checkGit(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (FILE_READING_COMMANDS.has(token)) {
			const r = checkFileReading(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (PATH_SENSITIVE_COMMANDS.has(token)) {
			const r = checkPathSensitive(tokens, i, token, cwd);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		i++;
	}

	return SAFE;
}
