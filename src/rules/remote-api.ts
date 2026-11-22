/**
 * Shared helpers for effect-based detection of destructive remote API calls
 * (GitHub REST `DELETE` and destructive GraphQL mutations), used by the `gh`
 * rule and the generic HTTP client rule.
 */

import { readFileSync } from "node:fs";
import {
	GH_DESTRUCTIVE_METHODS,
	GH_GRAPHQL_DESTRUCTIVE_MUTATIONS,
	GH_GRAPHQL_DESTRUCTIVE_MUTATION_PREFIXES,
} from "../config";
import { resolvePath } from "./path-utils";

/** Tokens that end a simple command (redirections do not). */
const COMMAND_SEPARATORS: ReadonlySet<string> = new Set(["|", ";", "&&", "||", "&", "(", ")"]);

/** Maximum payload file size read for GraphQL inspection. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Returns the index of the first command separator at or after `start`. */
export function segmentEnd(tokens: readonly string[], start: number): number {
	let j = start;
	while (j < tokens.length && !COMMAND_SEPARATORS.has(tokens[j]!)) j++;
	return j;
}

/** Whether a value depends on the shell at runtime (variable or substitution). */
export function isUnresolvable(value: string): boolean {
	return value.includes("$") || value.includes("`");
}

/**
 * Classifies an HTTP method value. Returns a block reason fragment for a
 * destructive or statically unresolvable method, or null when it is safe.
 */
export function methodReason(value: string): string | null {
	if (isUnresolvable(value)) {
		return `HTTP method ${JSON.stringify(value)} cannot be resolved statically`;
	}
	const upper = value.toUpperCase();
	return GH_DESTRUCTIVE_METHODS.has(upper) ? `method ${upper}` : null;
}

/**
 * Reads the method value of a short-option cluster such as `-XDELETE`,
 * `-X=DELETE`, `-iX DELETE` or `-sXDELETE`. Letters before `target` must be
 * boolean options; a letter in `valueLetters` consumes the rest of the token,
 * ending the scan. Returns undefined when the cluster has no `target` option.
 *
 * @param next The token after the cluster, used when the value is not attached.
 */
export function shortClusterValue(
	token: string,
	next: string | undefined,
	target: string,
	valueLetters: string,
): string | undefined {
	if (!token.startsWith("-") || token.startsWith("--") || token.length < 2) return undefined;
	for (let k = 1; k < token.length; k++) {
		const letter = token[k]!;
		if (letter === target) {
			let rest = token.slice(k + 1);
			if (rest.startsWith("=")) rest = rest.slice(1);
			return rest === "" ? next : rest;
		}
		if (valueLetters.includes(letter) || !/[A-Za-z]/.test(letter)) return undefined;
	}
	return undefined;
}

/**
 * Returns the first destructive GraphQL mutation field found in `text`, or
 * null. Only documents containing the `mutation` keyword are considered.
 */
export function findDestructiveMutation(text: string): string | null {
	if (!/\bmutation\b/.test(text)) return null;
	for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
		const name = match[0];
		if (GH_GRAPHQL_DESTRUCTIVE_MUTATIONS.has(name)) return name;
		for (const prefix of GH_GRAPHQL_DESTRUCTIVE_MUTATION_PREFIXES) {
			const next = name[prefix.length];
			if (name.startsWith(prefix) && next !== undefined && next >= "A" && next <= "Z") {
				return name;
			}
		}
	}
	return null;
}

/**
 * Reads a payload file for inspection. Returns null when it cannot be read
 * statically: stdin (`-`), a path with variables or globs, a missing or
 * unreadable file, or a file larger than the inspection limit.
 */
export function readPayloadFile(path: string, cwd: string): string | null {
	if (path === "-" || path === "") return null;
	const resolved = resolvePath(path, cwd);
	if (resolved === null) return null;
	try {
		const content = readFileSync(resolved);
		if (content.length > MAX_PAYLOAD_BYTES) return null;
		return content.toString("utf8");
	} catch {
		return null;
	}
}

/** Whether an endpoint or URL targets a GraphQL API (`graphql`, `/graphql`, `.../graphql?x`). */
export function isGraphqlEndpoint(endpoint: string): boolean {
	const path = endpoint.split(/[?#]/, 1)[0]!;
	return /(^|\/)graphql\/?$/.test(path);
}
