/**
 * Detects destructive requests to GitHub API hosts made with generic HTTP
 * clients (`curl`, `wget`, HTTPie `http`/`https`, `xh`/`xhs`): a `DELETE` or
 * statically unresolvable method, or a destructive GraphQL mutation sent to
 * the GraphQL endpoint.
 */

import {
	findDestructiveMutation,
	isGraphqlEndpoint,
	isUnresolvable,
	methodReason,
	readPayloadFile,
	segmentEnd,
	shortClusterValue,
} from "./remote-api";
import { type CheckResult, SAFE, block } from "./types";
import { HTTPIE_VALUE_FLAGS } from "./workdir-guard";

/** curl short options that take a value (they end a short-option cluster). */
const CURL_SHORT_VALUE_LETTERS = "AbcCdDEeFHKmoPQrTtuUwxyYz";

/** GitHub API host appearing in a token (URL, `--url=`, `Host:` header, ...). */
const GITHUB_API_HOST =
	/(?:^|[^A-Za-z0-9.-])(?:api\.github\.com|uploads\.github\.com|(?:[A-Za-z0-9-]+\.)*githubusercontent\.com)(?=$|[:/?#"'\s])/i;

/** A literal URL with a static host. */
const LITERAL_URL = /https?:\/\/[A-Za-z0-9]/i;

/** A GitHub token injected into the request. */
const GITHUB_TOKEN_INJECTION =
	/gh\s+auth\s+token|\$\{?(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)\b/;

/** URL tokens of the request: tokens carrying a GitHub API host or a literal URL. */
function urlTokens(args: readonly string[]): string[] {
	return args.filter((arg) => GITHUB_API_HOST.test(arg) || LITERAL_URL.test(arg));
}

/**
 * Whether the request targets the GitHub API: a GitHub API host appears in
 * the command, or a GitHub token is injected and no literal URL names another
 * host (the URL is a variable or substitution).
 */
function targetsGitHub(args: readonly string[]): boolean {
	if (args.some((arg) => GITHUB_API_HOST.test(arg))) return true;
	return args.some((arg) => GITHUB_TOKEN_INJECTION.test(arg)) && !args.some((arg) => LITERAL_URL.test(arg));
}

/** Method values set with curl `-X`/`--request` in every spelling. */
function curlMethods(args: readonly string[]): string[] {
	const methods: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k]!;
		if (arg === "--request") {
			if (args[k + 1] !== undefined) methods.push(args[k + 1]!);
			continue;
		}
		if (arg.startsWith("--request=")) {
			methods.push(arg.slice("--request=".length));
			continue;
		}
		const value = shortClusterValue(arg, args[k + 1], "X", CURL_SHORT_VALUE_LETTERS);
		if (value !== undefined) methods.push(value);
	}
	return methods;
}

/** Method values set with wget `--method`. */
function wgetMethods(args: readonly string[]): string[] {
	const methods: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k]!;
		if (arg === "--method" && args[k + 1] !== undefined) methods.push(args[k + 1]!);
		else if (arg.startsWith("--method=")) methods.push(arg.slice("--method=".length));
	}
	return methods;
}

/** HTTPie/xh `[METHOD] URL`: the first positional is a method when another follows. */
function httpieMethods(args: readonly string[]): string[] {
	const positionals: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k]!;
		if (arg.startsWith("-") && arg !== "-") {
			if (HTTPIE_VALUE_FLAGS.has(arg)) k++;
			continue;
		}
		positionals.push(arg);
	}
	const first = positionals[0];
	if (first === undefined || positionals.length < 2) return [];
	return /^[A-Za-z]+$/.test(first) || isUnresolvable(first) ? [first] : [];
}

/** Payload files referenced by the request (`-d @f`, `--data=@f`, `field=@f`, `--post-file f`). */
function payloadFiles(args: readonly string[]): string[] {
	const files: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k]!;
		if (arg === "--post-file" || arg === "--body-file") {
			if (args[k + 1] !== undefined) files.push(args[k + 1]!);
			k++;
		} else if (/^--(?:post|body)-file=/.test(arg)) {
			files.push(arg.slice(arg.indexOf("=") + 1));
		} else if (arg.startsWith("-d@")) {
			files.push(arg.slice(3));
		} else if (arg.startsWith("@")) {
			files.push(arg.slice(1));
		} else if (arg.includes("=@")) {
			files.push(arg.slice(arg.indexOf("=@") + 2));
		}
	}
	return files;
}

/**
 * Checks a generic HTTP client invocation for a destructive request to a
 * GitHub API host. Returns a blocking result with its reason, or `SAFE`.
 *
 * @param i Index of the client token in `tokens`.
 * @param cwd Directory payload files resolve against.
 */
export function checkHttpClient(tokens: string[], i: number, cwd: string): CheckResult {
	const client = tokens[i]!;
	const args = tokens.slice(i + 1, segmentEnd(tokens, i + 1));
	if (!targetsGitHub(args)) return SAFE;

	const methods =
		client === "curl" ? curlMethods(args) : client === "wget" ? wgetMethods(args) : httpieMethods(args);
	for (const method of methods) {
		const reason = methodReason(method);
		if (reason !== null) {
			return block(`destructive GitHub API request: ${client} with ${reason} to the GitHub API`);
		}
	}

	if (urlTokens(args).some(isGraphqlEndpoint)) {
		const texts = [...args];
		for (const file of payloadFiles(args)) {
			const content = readPayloadFile(file, cwd);
			if (content === null) {
				return block(
					`destructive GitHub API request: ${client} GraphQL payload ${JSON.stringify(file)} cannot be inspected`,
				);
			}
			texts.push(content);
		}
		const mutation = findDestructiveMutation(texts.join("\n"));
		if (mutation !== null) {
			return block(`destructive GitHub API request: ${client} GraphQL mutation ${mutation}`);
		}
	}
	return SAFE;
}
