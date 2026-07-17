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

/**
 * Resolves `p` to an absolute path. `resolveCwd` is the directory relative
 * paths are resolved against — this is the *dynamic* cwd, which may have
 * been shifted by a preceding `cd` in the same command chain (see
 * `checker.ts`'s `currentCwd` tracking).
 */
export function resolvePath(p: string, resolveCwd: string): string | null {
	const expanded = expandTilde(p);
	if (hasUnresolvableParts(expanded)) return null;
	if (isAbsolute(expanded)) return normalize(expanded);
	return normalize(resolve(resolveCwd, expanded));
}

/**
 * Checks whether `p` falls outside the safe boundary directory.
 *
 * `resolveCwd` is used only to turn a relative `p` into an absolute path
 * (it tracks `cd` within the command being analyzed); `boundaryCwd` is the
 * fixed, real working directory the resulting absolute path must stay
 * inside. They default to the same value when the command never `cd`s.
 */
export function isOutsideCwd(
	p: string,
	resolveCwd: string,
	boundaryCwd: string = resolveCwd,
): CheckResult {
	if (hasUnresolvableParts(p)) {
		return block(`unresolvable variable or glob in path: ${JSON.stringify(p)}`);
	}
	const resolved = resolvePath(p, resolveCwd);
	if (resolved === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	const boundaryRoot = boundaryCwd.replace(/\/+$/, "");
	const boundaryPrefix = `${boundaryRoot}/`;
	if (resolved === boundaryRoot || `${resolved}/`.startsWith(boundaryPrefix)) {
		return SAFE;
	}
	return block(
		`${JSON.stringify(resolved)} is outside the working directory ${JSON.stringify(boundaryCwd)}`,
	);
}
