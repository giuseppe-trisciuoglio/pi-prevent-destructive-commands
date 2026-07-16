/**
 * Recursive destructive command analyzer.
 *
 * Port of Claude's `_check_tokens`. Visits the token list recognizing wrappers,
 * shell invocations, `find -exec`, `xargs`, and dangerous commands (git, docker,
 * aws, path-sensitive, sensitive file reads). Returns the first block reason found.
 */

import { isAbsolute, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { tokenize } from "./tokenizer";
import {
	AWS_DESTRUCTIVE_SUBCOMMANDS,
	DELEGATION_COMMANDS,
	DOCKER_DESTRUCTIVE_COMPOUND,
	DOCKER_DESTRUCTIVE_SUBCOMMANDS,
	ENABLE_GIT_ADD_COMMIT_BLOCK,
	ENABLE_SENSITIVE_FILE_CHECK,
	FILE_READING_COMMANDS,
	FIND_EXEC_FLAGS,
	MAX_NESTING_DEPTH,
	PATH_SENSITIVE_COMMANDS,
	QUOTED_COMMAND_WRAPPERS,
	SENSITIVE_FILE_PATTERNS,
	SHELL_COMMANDS,
	SHELL_OPERATORS,
	WRAPPER_COMMANDS,
} from "./config";

export interface CheckResult {
	dangerous: boolean;
	reason: string;
}

const SAFE: CheckResult = { dangerous: false, reason: "" };

function block(reason: string): CheckResult {
	return { dangerous: true, reason };
}

// ─── Path Utilities ───────────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	if (p.startsWith("~")) {
		const username = p.slice(1).split("/")[0];
		return `/home/${username}`;
	}
	return p;
}

/** Returns `true` if the path contains variables/globs resolvable only at runtime. */
function hasUnresolvableParts(p: string): boolean {
	return /\$[{(]?|\*|\?|\[/.test(p) || p === "{}";
}

function resolvePath(p: string, cwd: string): string | null {
	const expanded = expandTilde(p);
	if (hasUnresolvableParts(expanded)) return null;
	if (isAbsolute(expanded)) return normalize(expanded);
	return normalize(resolve(cwd, expanded));
}

function isOutsideCwd(p: string, cwd: string): CheckResult {
	if (hasUnresolvableParts(p)) {
		return block(`unresolvable variable or glob in path: ${JSON.stringify(p)}`);
	}
	const resolved = resolvePath(p, cwd);
	if (resolved === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	const cwdRoot = cwd.replace(/\/+$/, "");
	const cwdPrefix = `${cwdRoot}/`;
	if (resolved === cwdRoot || `${resolved}/`.startsWith(cwdPrefix)) {
		return SAFE;
	}
	return block(
		`${JSON.stringify(resolved)} is outside the working directory ${JSON.stringify(cwd)}`,
	);
}

// ─── Recursive Checker ────────────────────────────────────────────────────────

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

// ─── Specific Handlers ────────────────────────────────────────────────────────

function checkAws(tokens: string[], i: number): CheckResult {
	const parts: string[] = [];
	let j = i + 1;
	while (j < tokens.length && tokens[j].startsWith("--")) j++;
	while (j < tokens.length && !tokens[j].startsWith("-") && parts.length < 3) {
		parts.push(tokens[j]);
		j++;
	}
	for (let length = parts.length; length > 0; length--) {
		const sub = parts.slice(0, length).join(" ");
		if (AWS_DESTRUCTIVE_SUBCOMMANDS.has(sub)) {
			return block(`destructive AWS CLI operation: aws ${sub}`);
		}
	}
	return SAFE;
}

function checkDocker(tokens: string[], i: number): CheckResult {
	if (i + 1 >= tokens.length) return SAFE;
	const sub1 = tokens[i + 1];
	const rest = tokens.slice(i + 2);

	if (i + 2 < tokens.length) {
		const compound = `${sub1} ${tokens[i + 2]}`;
		if (DOCKER_DESTRUCTIVE_COMPOUND.has(compound)) {
			return block(`destructive Docker operation: docker ${compound}`);
		}
	}
	if (DOCKER_DESTRUCTIVE_SUBCOMMANDS.has(sub1)) {
		return block(`destructive Docker operation: docker ${sub1}`);
	}
	if (sub1 === "compose" && i + 2 < tokens.length) {
		const composeSub = tokens[i + 2];
		if (composeSub === "down" && rest.includes("-v")) {
			return block("docker compose down -v removes volumes with data loss risk");
		}
		if (composeSub === "rm") {
			return block("docker compose rm removes stopped containers");
		}
	}
	if (sub1 === "context" && i + 2 < tokens.length && tokens[i + 2] === "rm") {
		return block("docker context rm removes Docker contexts");
	}
	if (
		sub1 === "swarm" &&
		i + 2 < tokens.length &&
		tokens[i + 2] === "leave" &&
		rest.includes("--force")
	) {
		return block("docker swarm leave --force forcibly removes the node from the swarm");
	}
	return SAFE;
}

const GIT_GLOBAL_FLAGS_WITH_ARG: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
	"--shallow-file",
	"--exec-path",
]);

/**
 * Finds the real git subcommand, skipping global flags (with and without
 * arguments) that may appear before the subcommand, like `-C <path>`.
 * Returns the subcommand index, or -1 if not found.
 */
function findGitSubcommandIndex(tokens: string[], start: number): number {
	let j = start + 1;
	while (j < tokens.length) {
		const t = tokens[j];
		if (!t || t === "--") return -1;
		if (GIT_GLOBAL_FLAGS_WITH_ARG.has(t)) {
			j += 2; // flag + argument
			continue;
		}
		if (t.startsWith("-")) {
			j++;
			continue;
		}
		return j; // first non-flag token = subcommand
	}
	return -1;
}

function checkGit(tokens: string[], i: number): CheckResult {
	const subIndex = findGitSubcommandIndex(tokens, i);
	if (subIndex === -1) return SAFE;
	const sub = tokens[subIndex];
	const rest = tokens.slice(subIndex + 1);

	if (sub === "reset" && rest.includes("--hard")) {
		return block("git reset --hard discards all local changes");
	}
	if (sub === "clean" && !rest.includes("-n") && !rest.includes("--dry-run")) {
		return block("git clean removes untracked files (use -n for a dry run first)");
	}
	if (sub === "push") {
		if (rest.includes("--force") || rest.includes("-f")) {
			return block("git push --force overwrites remote history (destructive)");
		}
		if (rest.includes("--force-with-lease")) {
			return block("git push --force-with-lease can overwrite remote history");
		}
		if (rest.includes("--delete")) {
			return block("git push --delete removes remote branches/tags");
		}
	}
	if (sub === "branch" && rest.includes("-D")) {
		return block("git branch -D force-deletes the branch without checks");
	}
	if (sub === "tag" && (rest.includes("-d") || rest.includes("--delete"))) {
		return block("git tag -d deletes the tag");
	}
	if (sub === "checkout" && (rest.includes("-f") || rest.includes("--force"))) {
		return block("git checkout -f forcefully discards local changes");
	}
	if (sub === "rebase") {
		return block("git rebase rewrites commit history (potentially destructive)");
	}
	if (sub === "filter-branch" || sub === "filter-repo") {
		return block(`git ${sub} rewrites repository history (highly destructive)`);
	}
	if (sub === "reflog" && rest.includes("expire")) {
		return block("git reflog expire deletes recovery references");
	}
	if (sub === "update-ref" && (rest.includes("-d") || rest.includes("--delete"))) {
		return block("git update-ref -d directly deletes git references");
	}
	if (ENABLE_GIT_ADD_COMMIT_BLOCK && sub === "add") {
		return block("git add stages changes to the index");
	}
	if (ENABLE_GIT_ADD_COMMIT_BLOCK && sub === "commit") {
		return block("git commit creates new commits in the repository");
	}
	return SAFE;
}

function checkFileReading(tokens: string[], i: number): CheckResult {
	if (!ENABLE_SENSITIVE_FILE_CHECK) return SAFE;
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		const argLower = arg.toLowerCase();
		for (const pattern of SENSITIVE_FILE_PATTERNS) {
			if (argLower.includes(pattern) || argLower.endsWith(pattern)) {
				return block(`attempt to read sensitive file: ${JSON.stringify(arg)}`);
			}
		}
		j++;
	}
	return SAFE;
}

function checkPathSensitive(
	tokens: string[],
	i: number,
	token: string,
	cwd: string,
): CheckResult {
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg === "--") {
			j++;
			continue;
		}
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		const r = isOutsideCwd(arg, cwd);
		if (r.dangerous) {
			return block(
				`${JSON.stringify(token)} targets a path outside the working directory — ${r.reason}`,
			);
		}
		j++;
	}
	return SAFE;
}
