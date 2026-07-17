/**
 * Path resolution helpers used to decide whether a path-sensitive command
 * (e.g. `rm`) targets a location outside the working directory.
 */

import { isAbsolute, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { type CheckResult, SAFE, block } from "./types";

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

export function isOutsideCwd(p: string, cwd: string): CheckResult {
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
