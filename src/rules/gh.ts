/**
 * Detects destructive GitHub CLI operations: `gh api` with a destructive or
 * unresolvable method, destructive GraphQL mutations through `gh api graphql`,
 * and destructive subcommands (`gh repo delete`, ...).
 */

import { GH_DESTRUCTIVE_SUBCOMMANDS } from "../config";
import { collectPositionalParts, matchLongestSubcommand } from "./args";
import {
	findDestructiveMutation,
	isGraphqlEndpoint,
	methodReason,
	readPayloadFile,
	segmentEnd,
	shortClusterValue,
} from "./remote-api";
import { type CheckResult, SAFE, block } from "./types";
import { GH_API_VALUE_FLAGS } from "./workdir-guard";

/** `gh api` short options that take a value (they end a short-option cluster). */
const GH_SHORT_VALUE_LETTERS = "XHfFqtp";

/** `gh api` field flags (`-f key=value`, `-F key=value`). */
const GH_FIELD_FLAGS: ReadonlySet<string> = new Set(["-f", "--raw-field", "-F", "--field"]);

/** `gh` global/persistent options that take a separate value (`-R owner/repo`). */
const GH_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(["-R", "--repo"]);

/** `gh pr close` options that take a separate value. */
const GH_PR_CLOSE_VALUE_FLAGS: ReadonlySet<string> = new Set(["-R", "--repo", "-c", "--comment"]);

/** `gh pr close` short options that take a value (they end a short-option cluster). */
const GH_PR_CLOSE_SHORT_VALUE_LETTERS = "Rc";

/**
 * Collects up to `max` positional arguments of the `gh` command in
 * `tokens[start, end)`, skipping options and the values of `-R`/`--repo`.
 */
function ghPositionals(tokens: readonly string[], start: number, end: number, max: number): string[] {
	const parts: string[] = [];
	for (let j = start; j < end && parts.length < max; j++) {
		const token = tokens[j]!;
		if (token.startsWith("-")) {
			if (GH_GLOBAL_VALUE_FLAGS.has(token)) j++;
			continue;
		}
		parts.push(token);
	}
	return parts;
}

/**
 * Whether a `gh pr close` command line asks to delete the head branch:
 * `-d`, `--delete-branch`, `--delete-branch=<not false>`, or `d` inside a
 * short-option cluster before any value-taking letter (`-Rd` is `-R d`).
 */
function prCloseDeletesBranch(tokens: readonly string[], start: number, end: number): boolean {
	for (let j = start; j < end; j++) {
		const token = tokens[j]!;
		if (token === "--") return false;
		if (GH_PR_CLOSE_VALUE_FLAGS.has(token)) {
			j++;
			continue;
		}
		if (token === "--delete-branch") return true;
		if (token.startsWith("--delete-branch=")) {
			return token.slice("--delete-branch=".length).toLowerCase() !== "false";
		}
		// Short cluster, possibly with an attached value (`-dRa/b`, `-dcmsg`): scan up to the first value letter.
		if (/^-[A-Za-z]/.test(token)) {
			for (const letter of token.slice(1)) {
				if (letter === "d") return true;
				if (GH_PR_CLOSE_SHORT_VALUE_LETTERS.includes(letter)) break;
			}
		}
	}
	return false;
}

/** Whether a GraphQL query text cannot be inspected statically. */
function isOpaqueQuery(text: string): boolean {
	return (
		text.includes("$(") ||
		text.includes("`") ||
		/^\s*["']?\$\{?[A-Za-z_][A-Za-z0-9_]*\}?["']?\s*$/.test(text)
	);
}

/**
 * Returns the `gh` method value at `tokens[j]`, in any spelling `gh` accepts:
 * `-X V`, `-XV`, `-X=V`, `-iX V` (cluster), `--method V`, `--method=V`.
 */
function ghMethodValue(tokens: readonly string[], j: number, end: number): string | undefined {
	const token = tokens[j]!;
	const next = j + 1 < end ? tokens[j + 1] : undefined;
	if (token === "--method") return next;
	if (token.startsWith("--method=")) return token.slice("--method=".length);
	return shortClusterValue(token, next, "X", GH_SHORT_VALUE_LETTERS);
}

/** Splits an option token into flag and attached value (`--field=v`, `-fv`). */
function splitAttached(token: string): { flag: string; value: string } | null {
	if (token.startsWith("--")) {
		const eq = token.indexOf("=");
		return eq > 2 ? { flag: token.slice(0, eq), value: token.slice(eq + 1) } : null;
	}
	if (token.startsWith("-") && token.length > 2) {
		return { flag: token.slice(0, 2), value: token.slice(2) };
	}
	return null;
}

/**
 * Inspects `gh api graphql` payloads for destructive mutations: inline
 * `query=` fields, `-F query=@file`, and `--input <file>`. Blocks when a
 * payload cannot be inspected (stdin, unreadable file, variable-only query).
 */
function checkGhGraphql(tokens: readonly string[], start: number, end: number, cwd: string): CheckResult {
	let endpoint: string | undefined;
	const texts: string[] = [];
	const files: string[] = [];
	let opaque: string | null = null;

	const addField = (flag: string, field: string, following: string | undefined): boolean => {
		const eq = field.indexOf("=");
		if (eq < 0 || field.slice(0, eq) !== "query") return false;
		let value = field.slice(eq + 1);
		// The tokenizer splits `query='...'` into `query=` and the quoted text.
		let consumed = false;
		if (value === "" && following !== undefined && !following.startsWith("-")) {
			value = following;
			consumed = true;
		}
		if ((flag === "-F" || flag === "--field") && value.startsWith("@")) {
			files.push(value.slice(1));
		} else if (isOpaqueQuery(value)) {
			opaque = value;
		} else {
			texts.push(value);
		}
		return consumed;
	};

	for (let j = start; j < end; j++) {
		const token = tokens[j]!;
		const following = j + 2 < end ? tokens[j + 2] : undefined;
		if (token.startsWith("-") && token !== "-") {
			if (GH_FIELD_FLAGS.has(token)) {
				const field = tokens[j + 1];
				if (field !== undefined && j + 1 < end && addField(token, field, following)) j++;
				j++;
				continue;
			}
			if (token === "--input") {
				const value = j + 1 < end ? tokens[j + 1] : undefined;
				if (value !== undefined) files.push(value);
				j++;
				continue;
			}
			if (GH_API_VALUE_FLAGS.has(token)) {
				j++;
				continue;
			}
			const attached = splitAttached(token);
			if (attached !== null && GH_FIELD_FLAGS.has(attached.flag)) {
				if (addField(attached.flag, attached.value, j + 1 < end ? tokens[j + 1] : undefined)) j++;
			} else if (attached !== null && attached.flag === "--input") {
				files.push(attached.value);
			}
			continue;
		}
		if (endpoint === undefined) endpoint = token;
	}

	if (endpoint === undefined || !isGraphqlEndpoint(endpoint)) return SAFE;

	if (opaque !== null) {
		return block(
			`destructive GitHub CLI operation: gh api graphql query ${JSON.stringify(opaque)} cannot be inspected statically`,
		);
	}
	for (const file of files) {
		const content = readPayloadFile(file, cwd);
		if (content === null) {
			return block(
				`destructive GitHub CLI operation: gh api graphql payload ${JSON.stringify(file)} cannot be inspected`,
			);
		}
		texts.push(content);
	}
	for (const text of texts) {
		const mutation = findDestructiveMutation(text);
		if (mutation !== null) {
			return block(`destructive GitHub CLI operation: gh api graphql mutation ${mutation}`);
		}
	}
	return SAFE;
}

/**
 * Checks tokens after `gh` for destructive method flags, GraphQL mutations,
 * or subcommands. The method flag is searched in the whole simple command; a
 * method that cannot be resolved statically blocks too.
 * Returns a blocking result with its reason, or `SAFE` when nothing matches.
 *
 * @param i Index of the `gh` token in `tokens`.
 * @param cwd Directory GraphQL payload files resolve against.
 */
export function checkGh(tokens: string[], i: number, cwd: string = process.cwd()): CheckResult {
	const end = segmentEnd(tokens, i + 1);
	for (let j = i + 1; j < end; j++) {
		const value = ghMethodValue(tokens, j, end);
		if (value === undefined) continue;
		const reason = methodReason(value);
		if (reason !== null) return block(`destructive GitHub CLI operation: gh api with ${reason}`);
	}

	if (tokens[i + 1] === "api") {
		const r = checkGhGraphql(tokens, i + 2, end, cwd);
		if (r.dangerous) return r;
	}

	// `gh pr close --delete-branch`: the PR is not merged, so deleting its head
	// branch can make commits unreachable. `gh pr merge -d` stays allowed: the
	// merged branch is reachable from the base.
	const [noun, verb] = ghPositionals(tokens, i + 1, end, 2);
	if (noun === "pr" && verb === "close" && prCloseDeletesBranch(tokens, i + 1, end)) {
		return block(
			"destructive GitHub CLI operation: gh pr close --delete-branch deletes the head branch of an unmerged PR (its commits may become unreachable) — run gh pr close without -d/--delete-branch and keep or archive the branch",
		);
	}

	// `gh <noun> <verb>`: match the longest known destructive subcommand pair.
	const parts = collectPositionalParts(tokens, i + 1, 2);
	const sub = matchLongestSubcommand(parts, GH_DESTRUCTIVE_SUBCOMMANDS);
	if (sub !== null) return block(`destructive GitHub CLI operation: gh ${sub}`);
	return SAFE;
}
