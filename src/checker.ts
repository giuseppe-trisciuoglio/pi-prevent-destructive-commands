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
	HEREDOC_EXECUTOR_COMMANDS,
	MAX_NESTING_DEPTH,
	PATH_SENSITIVE_COMMANDS,
	QUOTED_COMMAND_WRAPPERS,
	SHELL_COMMANDS,
	SHELL_OPERATORS,
	WRAPPER_COMMANDS,
} from "./config";
import { extractHeredocs } from "./heredoc";
import { checkAws } from "./rules/aws";
import { checkDocker } from "./rules/docker";
import { checkFileReading } from "./rules/file-reading";
import { checkGit } from "./rules/git";
import { checkPathSensitive } from "./rules/path-sensitive";
import { isOutsideCwd, resolvePath } from "./rules/path-utils";
import { type CheckResult, SAFE, block } from "./rules/types";

export type { CheckResult };

/** Per-call behavior toggles, resolved once per tool call from the project config. */
export interface CheckerOptions {
	gitGuardsEnabled: boolean;
}

const DEFAULT_CHECKER_OPTIONS: CheckerOptions = { gitGuardsEnabled: true };

/**
 * Heredoc-aware entry point for analyzing a raw command string.
 *
 * A heredoc body is stdin data for the command carrying the `<<` redirect,
 * not a command line: prose written through a heredoc would otherwise be
 * tokenized as shell syntax, colliding with natural-language words that look
 * like command names. The body is extracted and only analyzed as commands
 * when the remaining command line contains an executor (a shell, interpreter,
 * remote runner, …) that would actually run it. When extraction cannot parse
 * the string unambiguously, the original string is analyzed whole — the exact
 * pre-heredoc behavior.
 */
export function checkCommand(
	command: string,
	cwd: string,
	depth = 0,
	boundaryCwd: string = cwd,
	options: CheckerOptions = DEFAULT_CHECKER_OPTIONS,
): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"command nesting too deep to safely analyze (possible obfuscation)",
		);
	}

	const extraction = extractHeredocs(command);
	if (extraction === null) {
		return checkTokens(tokenize(command), cwd, depth, false, boundaryCwd, options);
	}

	const lineTokens = tokenize(extraction.text);
	const result = checkTokens(lineTokens, cwd, depth, false, boundaryCwd, options);
	if (result.dangerous) return result;

	if (extraction.bodies.length > 0 && lineTokens.some((t) => HEREDOC_EXECUTOR_COMMANDS.has(t))) {
		for (const body of extraction.bodies) {
			const r = checkCommand(body, cwd, depth + 1, boundaryCwd, options);
			if (r.dangerous) return r;
		}
	}

	return SAFE;
}

/**
 * @param cwd Directory relative paths resolve against for *this* call. At the top
 *   level this is the real working directory; recursive calls pass the effective
 *   `currentCwd` tracked at the point of recursion (see the `cd` handling below).
 * @param depth Recursion guard against obfuscated nesting.
 * @param stdinArgs `true` when this token list is the delegate of `xargs`/`parallel`:
 *   a path-sensitive command with no explicit target here will receive its real
 *   arguments from stdin at runtime, which static analysis cannot see.
 * @param boundaryCwd The fixed, real working directory that resolved paths must stay
 *   inside. Always the original top-level cwd, propagated unchanged through every
 *   recursion level — unlike `cwd`, it never shifts because of a `cd` inside a nested
 *   `bash -c`, `find -exec`, or `xargs` delegate.
 */
export function checkTokens(
	tokens: string[],
	cwd: string,
	depth = 0,
	stdinArgs = false,
	boundaryCwd: string = cwd,
	options: CheckerOptions = DEFAULT_CHECKER_OPTIONS,
): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"command nesting too deep to safely analyze (possible obfuscation)",
		);
	}

	// Tracks the effective working directory as `cd` is encountered in this same
	// command chain (e.g. `cd /; rm etc/passwd`). `null` means a preceding `cd`
	// target could not be statically resolved, so the effective cwd is unknown.
	let currentCwd: string | null = cwd;
	const cwdStack: (string | null)[] = [];

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];

		if (!token) {
			i++;
			continue;
		}

		// `(` / `)` scope a subshell: a `cd` inside it doesn't leak back out.
		if (token === "(") {
			cwdStack.push(currentCwd);
			i++;
			continue;
		}
		if (token === ")") {
			currentCwd = cwdStack.length > 0 ? (cwdStack.pop() ?? cwd) : cwd;
			i++;
			continue;
		}

		if (SHELL_OPERATORS.has(token)) {
			i++;
			continue;
		}

		// `cd`: updates the effective cwd used to resolve relative paths for
		// path-sensitive commands later in this same chain.
		if (token === "cd") {
			let j = i + 1;
			let target: string | null = null;
			let found = false;
			while (j < tokens.length) {
				const arg = tokens[j];
				if (!arg || SHELL_OPERATORS.has(arg)) break;
				if (arg.startsWith("-") && arg !== "-") {
					j++;
					continue;
				}
				target = arg;
				found = true;
				j++;
				break;
			}
			if (currentCwd === null) {
				// Already unknown — stays unknown.
			} else if (!found) {
				currentCwd = resolvePath("~", currentCwd);
			} else if (target === "-") {
				// `cd -` (previous directory): not statically knowable.
				currentCwd = null;
			} else if (target !== null) {
				currentCwd = resolvePath(target, currentCwd);
			}
			i = j;
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
				const r = checkCommand(arg, currentCwd ?? cwd, depth + 1, boundaryCwd, options);
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
				const r = checkCommand(tokens[j + 1], currentCwd ?? cwd, depth + 1, boundaryCwd, options);
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

		// `find`: validate the start paths against the boundary directory, then
		// recurse into any -exec delegate. Start paths are the consecutive
		// non-flag tokens right after `find` (after skipping leading flags such
		// as -L/-H/-P); the first option token ends the list.
		if (token === "find") {
			let j = i + 1;
			while (j < tokens.length && tokens[j]?.startsWith("-")) {
				j++;
			}
			while (j < tokens.length && !tokens[j]!.startsWith("-")) {
				const startPath = tokens[j]!;
				if (currentCwd === null || SHELL_OPERATORS.has(startPath)) {
					return block(
						`cannot verify ${JSON.stringify("find")}'s search root: a preceding "cd" changed the working directory to a location that could not be statically resolved`,
					);
				}
				const r = isOutsideCwd(startPath, currentCwd, boundaryCwd);
				if (r.dangerous) {
					return block(
						`${JSON.stringify("find")} searches outside the working directory — ${r.reason}`,
					);
				}
				j++;
			}
			while (j < tokens.length) {
				if (FIND_EXEC_FLAGS.has(tokens[j]) && j + 1 < tokens.length) {
					let end = j + 2;
					while (end < tokens.length && !["\\;", "+", ";"].includes(tokens[end])) {
						end++;
					}
					const r = checkTokens(
						tokens.slice(j + 1, end),
						currentCwd ?? cwd,
						depth + 1,
						false,
						boundaryCwd,
						options,
					);
					if (r.dangerous) return r;
				}
				j++;
			}
			i++;
			continue;
		}

		// xargs / parallel: delegate the following command. Its real arguments may
		// arrive via stdin at runtime, invisible to static token analysis.
		if (DELEGATION_COMMANDS.has(token)) {
			if (i + 1 < tokens.length) {
				const r = checkTokens(
					tokens.slice(i + 1),
					currentCwd ?? cwd,
					depth + 1,
					true,
					boundaryCwd,
					options,
				);
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
			const r = checkGit(tokens, i, options.gitGuardsEnabled);
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
			if (currentCwd === null) {
				return block(
					`cannot verify ${JSON.stringify(token)}'s target: a preceding "cd" changed the working directory to a location that could not be statically resolved`,
				);
			}
			const r = checkPathSensitive(tokens, i, token, currentCwd, boundaryCwd, stdinArgs);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		i++;
	}

	return SAFE;
}
