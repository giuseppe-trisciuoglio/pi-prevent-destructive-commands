/** Detects destructive Git operations (`git reset --hard`, `git push --force`, ...). */

import { ENABLE_GIT_ADD_COMMIT_BLOCK } from "../config";
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

export function checkGit(tokens: string[], i: number): CheckResult {
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
