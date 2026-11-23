/** Detects destructive Git operations (`git reset --hard`, `git push --force`, ...). */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SHELL_OPERATORS } from "../config";
import { resolvePath } from "./path-utils";
import { type CheckResult, SAFE, block } from "./types";

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

/**
 * Options that make `git commit` non-interactive, i.e. it does not open the
 * editor and therefore cannot hang an unattended agent session.
 */
const COMMIT_MESSAGE_OPTIONS: ReadonlySet<string> = new Set([
	"-m",
	"--message",
	"-F",
	"--file",
	"-C",
	"--reuse-message",
	"-c",
	"--reedit-message",
	"--no-edit",
	"--fixup",
]);

const COMMIT_MESSAGE_OPTION_PREFIXES: readonly string[] = [
	"--message=",
	"--file=",
	"--reuse-message=",
	"--reedit-message=",
	"--fixup=",
];

function commitProvidesMessage(rest: string[]): boolean {
	for (const t of rest) {
		if (COMMIT_MESSAGE_OPTIONS.has(t)) return true;
		if (COMMIT_MESSAGE_OPTION_PREFIXES.some((p) => t.startsWith(p))) return true;
		// Combined short options like "-am" (where the message arg follows) or
		// inline short messages like "-mx".
		if (/^-[a-zA-Z]*m[a-zA-Z]*$/.test(t)) return true;
	}
	return false;
}

/** Runs git with `args`; returns trimmed stdout, or `null` on any failure. */
function runGit(args: string[]): string | null {
	try {
		return execFileSync("git", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5000,
		}).trim();
	} catch {
		return null;
	}
}

/**
 * Resolves the directory git runs in, applying every `-C <dir>` global option
 * between `git` and the subcommand. Returns `null` when a directory cannot be
 * resolved statically.
 */
function gitWorkingDirectory(tokens: string[], i: number, subIndex: number, cwd: string | null): string | null {
	let dir = cwd;
	for (let j = i + 1; j < subIndex; j++) {
		if (tokens[j] !== "-C") continue;
		const value = tokens[j + 1];
		if (dir === null || value === undefined || /[$`]/.test(value)) return null;
		dir = resolvePath(value, dir);
		j++;
	}
	return dir;
}

/** Whether `git worktree remove` options include `--force`/`-f` (also `-ff`, `-f -f`). */
function worktreeRemoveForced(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		// git accepts unambiguous long-option abbreviations (`--fo`, `--for`, `--forc`).
		if (/^--fo(r(ce?)?)?$/.test(arg)) return true;
		if (/^-[A-Za-z]+$/.test(arg) && arg.includes("f")) return true;
	}
	return false;
}

/**
 * Checks `git worktree remove --force <path>`. Forced removal discards
 * uncommitted and untracked changes and removes locked worktrees, so it is
 * allowed only when the worktree is verifiably clean and unlocked (then it has
 * the same effect as a plain remove). Any state that cannot be checked blocks.
 */
function checkWorktreeRemove(args: string[], baseDir: string | null): CheckResult {
	if (!worktreeRemoveForced(args)) return SAFE;
	let target: string | undefined;
	let afterDashes = false;
	for (const arg of args) {
		if (!afterDashes && arg === "--") {
			afterDashes = true;
			continue;
		}
		if (!afterDashes && arg.startsWith("-")) continue;
		target = arg;
		break;
	}
	const cannotVerify = (why: string) =>
		block(
			`git worktree remove --force discards uncommitted and untracked changes and removes locked worktrees — ${why}; commit or stash the changes and use git worktree remove without --force`,
		);
	if (target === undefined) return cannotVerify("no worktree path found");
	if (baseDir === null || /[$`*?[]/.test(target)) {
		return cannotVerify(`the worktree path ${JSON.stringify(target)} cannot be resolved statically`);
	}
	const path = resolvePath(target, baseDir);
	if (path === null) {
		return cannotVerify(`the worktree path ${JSON.stringify(target)} cannot be resolved statically`);
	}
	if (!existsSync(path)) return cannotVerify(`the worktree ${JSON.stringify(target)} cannot be inspected`);
	const status = runGit(["-C", path, "status", "--porcelain", "--untracked-files=all"]);
	if (status === null) return cannotVerify(`the state of ${JSON.stringify(target)} cannot be checked`);
	if (status !== "") return cannotVerify(`${JSON.stringify(target)} has uncommitted or untracked changes`);
	const gitDir = runGit(["-C", path, "rev-parse", "--absolute-git-dir"]);
	if (gitDir === null) return cannotVerify(`the state of ${JSON.stringify(target)} cannot be checked`);
	if (existsSync(join(gitDir, "locked"))) return cannotVerify(`${JSON.stringify(target)} is locked`);
	return SAFE;
}

/**
 * @param cwd Directory relative worktree paths resolve against; `null` when a
 *   preceding `cd` made it unknowable.
 */
export function checkGit(
	tokens: string[],
	i: number,
	gitGuardsEnabled: boolean,
	cwd: string | null = process.cwd(),
): CheckResult {
	const subIndex = findGitSubcommandIndex(tokens, i);
	if (subIndex === -1) return SAFE;
	const sub = tokens[subIndex];
	const rest = tokens.slice(subIndex + 1);

	if (sub === "worktree" && rest[0] === "remove") {
		let end = 1;
		while (end < rest.length && rest[end] && !SHELL_OPERATORS.has(rest[end]!)) end++;
		const r = checkWorktreeRemove(rest.slice(1, end), gitWorkingDirectory(tokens, i, subIndex, cwd));
		if (r.dangerous) return r;
	}

	if (sub === "reset" && rest.includes("--hard")) {
		return block("git reset --hard discards all local changes");
	}
	if (sub === "clean" && !rest.includes("-n") && !rest.includes("--dry-run")) {
		return block("git clean removes untracked files (use -n for a dry run first)");
	}
	if (sub === "push") {
		// Forceful and deleting pushes stay blocked unconditionally: they are
		// destructive regardless of any per-project opt-out.
		if (rest.includes("--force") || rest.includes("-f")) {
			return block("git push --force overwrites remote history (destructive)");
		}
		if (rest.includes("--force-with-lease")) {
			return block("git push --force-with-lease can overwrite remote history");
		}
		if (rest.includes("--delete")) {
			return block("git push --delete removes remote branches/tags");
		}
		if (gitGuardsEnabled) {
			return block("git push publishes commits to the remote repository");
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
	if (gitGuardsEnabled && sub === "add") {
		return block("git add stages changes to the index");
	}
	if (sub === "commit" && !commitProvidesMessage(rest)) {
		// Applies unconditionally (like the push --force block): a bare
		// interactive `git commit` opens $EDITOR and hangs the GUI when the
		// agent commits autonomously, even on opted-out projects.
		return block(
			"git commit without a message opens the interactive editor and hangs the session — use -m to provide the commit message",
		);
	}
	if (gitGuardsEnabled && sub === "commit") {
		return block("git commit creates new commits in the repository");
	}
	return SAFE;
}
