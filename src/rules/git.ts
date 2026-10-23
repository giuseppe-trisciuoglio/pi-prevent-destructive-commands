/** Detects destructive Git operations (`git reset --hard`, `git push --force`, ...). */

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

export function checkGit(tokens: string[], i: number, gitGuardsEnabled: boolean): CheckResult {
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
