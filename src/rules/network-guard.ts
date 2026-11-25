/**
 * Network guard: blocks `curl` and `wget` requests to hosts other than the
 * local loopback interface unless the user authorized network access for the
 * project (`/network-guard off`). Private networks, link-local addresses,
 * mDNS `*.local` names and single-label hosts are all treated as external.
 *
 * Classification is purely static: hostnames are never resolved through DNS,
 * and a target that cannot be resolved without running the shell (variable,
 * substitution, glob) is treated as external.
 */

import { isIPv4 } from "node:net";
import { SHELL_OPERATORS, WRAPPER_COMMANDS } from "../config";
import { isUnresolvable, segmentEnd, shortClusterValue } from "./remote-api";
import { type CheckResult, SAFE, block } from "./types";

/** Clients covered by the network guard. */
export const NETWORK_GUARD_CLIENTS: ReadonlySet<string> = new Set(["curl", "wget"]);

/** curl short options that take a value (they end a short-option cluster). */
const CURL_SHORT_VALUE_LETTERS = "AbcCdDEeFHKmoPQrTtuUwxyYz";

/** curl long options that take a separate value. */
const CURL_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--abstract-unix-socket", "--alt-svc", "--aws-sigv4", "--cacert", "--capath", "--cert", "--cert-type",
	"--ciphers", "--config", "--connect-timeout", "--connect-to", "--cookie", "--cookie-jar",
	"--create-file-mode", "--crlfile", "--curves", "--data", "--data-ascii", "--data-binary", "--data-raw",
	"--data-urlencode", "--delegation", "--dns-interface", "--dns-ipv4-addr", "--dns-ipv6-addr",
	"--dns-servers", "--doh-url", "--dump-header", "--ech", "--egd-file", "--engine", "--etag-compare",
	"--etag-save", "--expect100-timeout", "--form", "--form-string", "--ftp-account",
	"--ftp-alternative-to-user", "--ftp-method", "--ftp-port", "--ftp-ssl-ccc-mode",
	"--happy-eyeballs-timeout-ms", "--header", "--hostpubmd5", "--hostpubsha256", "--hsts", "--interface",
	"--ip-tos", "--ipfs-gateway", "--json", "--keepalive-cnt", "--keepalive-time", "--key", "--key-type",
	"--krb", "--libcurl", "--limit-rate", "--local-port", "--login-options", "--mail-auth", "--mail-from",
	"--mail-rcpt", "--max-filesize", "--max-redirs", "--max-time", "--netrc-file", "--noproxy",
	"--oauth2-bearer", "--output", "--output-dir", "--parallel-max", "--pass", "--pinnedpubkey",
	"--preproxy", "--proto", "--proto-default", "--proto-redir", "--proxy", "--proxy-cacert",
	"--proxy-capath", "--proxy-cert", "--proxy-cert-type", "--proxy-ciphers", "--proxy-crlfile",
	"--proxy-header", "--proxy-key", "--proxy-key-type", "--proxy-pass", "--proxy-pinnedpubkey",
	"--proxy-service-name", "--proxy-tls13-ciphers", "--proxy-tlsauthtype", "--proxy-tlspassword",
	"--proxy-tlsuser", "--proxy-user", "--proxy1.0", "--pubkey", "--quote", "--random-file", "--range",
	"--rate", "--referer", "--request", "--request-target", "--resolve", "--retry", "--retry-delay",
	"--retry-max-time", "--sasl-authzid", "--service-name", "--socks4", "--socks4a", "--socks5",
	"--socks5-gssapi-service", "--socks5-hostname", "--speed-limit", "--speed-time", "--stderr",
	"--telnet-option", "--tftp-blksize", "--time-cond", "--tls-max", "--tls13-ciphers", "--tlsauthtype",
	"--tlspassword", "--tlsuser", "--trace", "--trace-ascii", "--trace-config", "--unix-socket",
	"--upload-file", "--url", "--url-query", "--user", "--user-agent", "--variable", "--vlan-priority",
	"--write-out",
]);

/** curl options whose value is a proxy URL the request is sent through. */
const CURL_PROXY_OPTIONS: ReadonlySet<string> = new Set([
	"--proxy", "--preproxy", "--proxy1.0", "--socks4", "--socks4a", "--socks5", "--socks5-hostname",
]);

/** wget short options that take a value (they end a short-option cluster). */
const WGET_SHORT_VALUE_LETTERS = "eoaiBtOTwQPlADRIXU";

/** wget long options that take a separate value. */
const WGET_LONG_VALUE_OPTIONS: ReadonlySet<string> = new Set([
	"--output-file", "--append-output", "--execute", "--input-file", "--base", "--config", "--bind-address",
	"--bind-dns-address", "--dns-servers", "--tries", "--output-document", "--timeout", "--dns-timeout",
	"--connect-timeout", "--read-timeout", "--wait", "--waitretry", "--quota", "--limit-rate",
	"--directory-prefix", "--user-agent", "--level", "--accept", "--reject", "--domains",
	"--exclude-domains", "--include-directories", "--exclude-directories", "--header", "--method",
	"--body-data", "--body-file", "--post-data", "--post-file", "--user", "--password", "--http-user",
	"--http-password", "--ftp-user", "--ftp-password", "--proxy-user", "--proxy-password", "--referer",
	"--load-cookies", "--save-cookies", "--ca-certificate", "--ca-directory", "--certificate",
	"--private-key", "--certificate-type", "--private-key-type", "--secure-protocol", "--ciphers",
	"--restrict-file-names", "--local-encoding", "--remote-encoding", "--default-page", "--cut-dirs",
	"--progress", "--report-speed", "--backups", "--rejected-log", "--regex-type", "--accept-regex",
	"--reject-regex", "--crl-file", "--pinnedpubkey", "--random-file", "--egd-file", "--hsts-file",
	"--warc-file", "--warc-header", "--warc-max-size", "--warc-cdx", "--warc-dedup", "--warc-tempdir",
	"--use-askpass", "--prefer-family", "--max-redirect", "--start-pos", "--xattr",
]);

/** What a client invocation would contact, as far as static analysis can tell. */
interface RequestTargets {
	/** Raw values naming a host (URLs, proxies, connect-to destinations). */
	hosts: string[];
	/** Reason the targets cannot be inspected at all, or null. */
	opaque: string | null;
}

function splitLongOption(arg: string): { name: string; value: string | undefined } {
	const eq = arg.indexOf("=");
	return eq === -1 ? { name: arg, value: undefined } : { name: arg.slice(0, eq), value: arg.slice(eq + 1) };
}

/** Whether a short cluster ends with a value-taking letter whose value is the next token. */
function shortClusterConsumesNext(arg: string, valueLetters: string): boolean {
	for (let k = 1; k < arg.length; k++) {
		const letter = arg[k]!;
		if (valueLetters.includes(letter)) return k === arg.length - 1;
		if (!/[A-Za-z0-9]/.test(letter)) return false;
	}
	return false;
}

/** Hosts a curl `--connect-to HOST1:PORT1:HOST2:PORT2` or `--resolve HOST:PORT:ADDR[,ADDR]` value redirects to. */
function curlRedirectHosts(name: string, value: string): string[] {
	if (isUnresolvable(value)) return [value];
	if (name === "--connect-to") {
		const match = /^(?:\[[^\]]*\]|[^:]*):[^:]*:(\[[^\]]*\]|[^:]*)(?::.*)?$/.exec(value);
		if (!match) return [value];
		return match[1] === "" ? [] : [match[1]!];
	}
	const parts = value.replace(/^[+-]/, "").match(/^(?:\[[^\]]*\]|[^:]*):[^:]*:(.*)$/);
	if (!parts) return [value];
	return parts[1]!.split(",").filter((addr) => addr !== "");
}

function curlTargets(args: readonly string[]): RequestTargets {
	const hosts: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k]!;
		if (arg === "--") {
			hosts.push(...args.slice(k + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const { name, value: attached } = splitLongOption(arg);
			const takesValue = CURL_LONG_VALUE_OPTIONS.has(name);
			const value = attached ?? (takesValue ? args[k + 1] : undefined);
			if (attached === undefined && takesValue) k++;
			if (value === undefined) continue;
			if (name === "--config") return { hosts, opaque: `curl ${name} ${JSON.stringify(value)} reads options from a file that cannot be inspected` };
			if (name === "--url") {
				if (value.startsWith("@")) return { hosts, opaque: `curl --url ${JSON.stringify(value)} reads URLs from a file that cannot be inspected` };
				hosts.push(value);
			} else if (CURL_PROXY_OPTIONS.has(name) || name === "--doh-url") {
				hosts.push(value);
			} else if (name === "--connect-to" || name === "--resolve") {
				hosts.push(...curlRedirectHosts(name, value));
			}
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			const config = shortClusterValue(arg, args[k + 1], "K", CURL_SHORT_VALUE_LETTERS);
			if (config !== undefined) return { hosts, opaque: `curl -K ${JSON.stringify(config)} reads options from a file that cannot be inspected` };
			const proxy = shortClusterValue(arg, args[k + 1], "x", CURL_SHORT_VALUE_LETTERS);
			if (proxy !== undefined) hosts.push(proxy);
			if (shortClusterConsumesNext(arg, CURL_SHORT_VALUE_LETTERS)) k++;
			continue;
		}
		hosts.push(arg);
	}
	return { hosts, opaque: null };
}

function wgetTargets(args: readonly string[]): RequestTargets {
	const hosts: string[] = [];
	for (let k = 0; k < args.length; k++) {
		const arg = args[k]!;
		if (arg === "--") {
			hosts.push(...args.slice(k + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const { name, value: attached } = splitLongOption(arg);
			const takesValue = WGET_LONG_VALUE_OPTIONS.has(name);
			const value = attached ?? (takesValue ? args[k + 1] : undefined);
			if (attached === undefined && takesValue) k++;
			if (value === undefined) continue;
			if (name === "--input-file") return { hosts, opaque: `wget ${name} ${JSON.stringify(value)} reads URLs from a file that cannot be inspected` };
			if (name === "--config") return { hosts, opaque: `wget ${name} ${JSON.stringify(value)} reads options from a file that cannot be inspected` };
			if (name === "--base") hosts.push(value);
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			const input = shortClusterValue(arg, args[k + 1], "i", WGET_SHORT_VALUE_LETTERS);
			if (input !== undefined) return { hosts, opaque: `wget -i ${JSON.stringify(input)} reads URLs from a file that cannot be inspected` };
			const base = shortClusterValue(arg, args[k + 1], "B", WGET_SHORT_VALUE_LETTERS);
			if (base !== undefined) hosts.push(base);
			if (shortClusterConsumesNext(arg, WGET_SHORT_VALUE_LETTERS)) k++;
			continue;
		}
		hosts.push(arg);
	}
	return { hosts, opaque: null };
}

/** Result of classifying one target value. */
export type HostClass =
	| { kind: "local" }
	| { kind: "ignored" }
	| { kind: "external"; host: string }
	| { kind: "unresolvable"; value: string };

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * Extracts and classifies the host named by a URL, proxy, or address value.
 * `file://` URLs are not network requests and are ignored.
 */
export function classifyTarget(value: string): HostClass {
	if (isUnresolvable(value) || value.includes("{{")) return { kind: "unresolvable", value };

	let rest = value;
	const scheme = SCHEME.exec(value);
	if (scheme) {
		if (scheme[1]!.toLowerCase() === "file") return { kind: "ignored" };
		rest = value.slice(scheme[0].length);
	}

	let authority = rest.split(/[/?#]/, 1)[0]!;
	const at = authority.lastIndexOf("@");
	if (at !== -1) authority = authority.slice(at + 1);

	const bracketed = /^\[[^\]]*\]/.exec(authority);
	const hostPart = bracketed ? bracketed[0] : authority.split(":", 1)[0]!;
	const remainder = authority.slice(hostPart.length);
	if (hostPart === "" || /[{}*?[\]]/.test(bracketed ? remainder : hostPart)) {
		return { kind: "unresolvable", value };
	}

	let hostname: string;
	try {
		hostname = new URL(`http://${hostPart}`).hostname;
	} catch {
		return { kind: "unresolvable", value };
	}
	hostname = hostname.toLowerCase().replace(/\.$/, "");

	return isLoopbackHost(hostname) ? { kind: "local" } : { kind: "external", host: hostname };
}

/**
 * Whether a normalized hostname (WHATWG URL form: IPv6 in brackets, IPv4 in
 * dotted decimal) is the local loopback interface.
 */
export function isLoopbackHost(hostname: string): boolean {
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (isIPv4(hostname)) return hostname.startsWith("127.") || hostname === "0.0.0.0";
	if (hostname === "[::1]") return true;
	const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(hostname);
	if (mapped) return parseInt(mapped[1]!, 16) >> 8 === 127;
	return false;
}

/** Prefixes that run the next word as a command, besides `WRAPPER_COMMANDS`. */
const COMMAND_PREFIXES: ReadonlySet<string> = new Set(["command", "exec", "stdbuf"]);

/**
 * Whether the token at `i` is in command position: at the start of a command,
 * or preceded only by wrappers (`sudo -u root`, `env A=1`, `timeout 10`), so
 * `grep curl README.md` is not mistaken for a curl invocation. A word that
 * follows an option is treated as that option's value.
 */
export function isCommandPosition(tokens: readonly string[], i: number): boolean {
	for (let j = i - 1; j >= 0; j--) {
		const token = tokens[j]!;
		if (SHELL_OPERATORS.has(token) || token === "(" || token === ")") return true;
		if (
			WRAPPER_COMMANDS.has(token) ||
			COMMAND_PREFIXES.has(token) ||
			token.startsWith("-") ||
			/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) ||
			/^\d+(?:\.\d+)?[smhd]?$/.test(token)
		) {
			continue;
		}
		if (j > 0 && tokens[j - 1]!.startsWith("-")) continue;
		return false;
	}
	return true;
}

/** Block reason suffix shared by every network guard result. */
const AUTHORIZE_HINT = "network access to external hosts is not authorized for this project — the user can allow it with /network-guard off";

/**
 * Checks a `curl` or `wget` invocation for requests to non-loopback hosts.
 *
 * @param i Index of the client token in `tokens`.
 */
export function checkNetworkAccess(tokens: string[], i: number): CheckResult {
	if (!isCommandPosition(tokens, i)) return SAFE;
	const client = tokens[i]!;
	const args = tokens.slice(i + 1, segmentEnd(tokens, i + 1));
	const { hosts, opaque } = client === "curl" ? curlTargets(args) : wgetTargets(args);
	if (opaque !== null) return block(`${opaque}; ${AUTHORIZE_HINT}`);

	for (const value of hosts) {
		const result = classifyTarget(value);
		if (result.kind === "external") {
			return block(`${client} request to external host ${JSON.stringify(result.host)}: ${AUTHORIZE_HINT}`);
		}
		if (result.kind === "unresolvable") {
			return block(`${client} target ${JSON.stringify(result.value)} cannot be resolved statically: ${AUTHORIZE_HINT}`);
		}
	}
	return SAFE;
}
