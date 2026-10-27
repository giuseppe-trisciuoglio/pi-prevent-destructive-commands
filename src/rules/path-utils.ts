/**
 * Path resolution helpers used to decide whether a path-sensitive command
 * (e.g. `rm`) targets a location outside the working directory.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { SKILL_ROOT_RELATIVE_PATHS } from "../config";
import { globLeavesPrefix, hasGlobMagic, hasShellVariable, splitGlobPattern } from "./glob";
import { type CheckResult, SAFE, block } from "./types";

export type PathAccess = "read" | "write" | "redirect";

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	if (p.startsWith("~")) {
		const username = p.slice(1).split("/")[0];
		return `/home/${username}`;
	}
	return p;
}

function stripTrailingSlashes(p: string): string {
	const trimmed = p.replace(/\/+$/, "");
	return trimmed.length > 0 ? trimmed : "/";
}

function canonicalDir(directory: string): string {
	const trimmed = stripTrailingSlashes(directory);
	try {
		return stripTrailingSlashes(realpathSync(trimmed));
	} catch {
		return trimmed;
	}
}

const SYSTEM_TEMP_ROOT_SET: ReadonlySet<string> = new Set(
	[tmpdir(), "/tmp", "/private/tmp"].flatMap((directory) => [
		stripTrailingSlashes(directory),
		canonicalDir(directory),
	]),
);

const SYSTEM_TEMP_ROOTS: readonly string[] = [...SYSTEM_TEMP_ROOT_SET];

const NULL_DEVICE_PATH = "/dev/null";

function isNullDevice(resolvedPath: string): boolean {
	return resolvedPath === NULL_DEVICE_PATH;
}

export function isSystemTempPath(resolvedPath: string): boolean {
	const target = stripTrailingSlashes(resolvedPath);
	return SYSTEM_TEMP_ROOTS.some((root) => root === "/" || target === root || target.startsWith(`${root}/`));
}

export function isSystemTempRoot(resolvedPath: string): boolean {
	return SYSTEM_TEMP_ROOT_SET.has(stripTrailingSlashes(resolvedPath));
}

const SKILL_ROOT_SET: ReadonlySet<string> = new Set(
	SKILL_ROOT_RELATIVE_PATHS.flatMap((p) => {
		const expanded = stripTrailingSlashes(expandTilde(p));
		return [expanded, canonicalDir(expanded)];
	}),
);

const SKILL_ROOTS: readonly string[] = [...SKILL_ROOT_SET];

export function isSkillPath(resolvedPath: string): boolean {
	const target = stripTrailingSlashes(resolvedPath);
	return SKILL_ROOTS.some((root) => target === root || target.startsWith(`${root}/`));
}

/**
 * Resolves `p` to an absolute path. `resolveCwd` is the directory relative
 * paths are resolved against — this is the *dynamic* cwd, which may have
 * been shifted by a preceding `cd` in the same command chain (see
 * `checker.ts`'s `currentCwd` tracking).
 */
export function resolvePath(p: string, resolveCwd: string): string | null {
	const expanded = expandTilde(p);
	if (hasShellVariable(expanded) || hasGlobMagic(expanded)) return null;
	if (isAbsolute(expanded)) return normalize(expanded);
	return normalize(resolve(resolveCwd, expanded));
}

function isInsideBoundary(resolved: string, boundaryCwd: string): boolean {
	const boundaryRoot = stripTrailingSlashes(boundaryCwd);
	const boundaryPrefix = `${boundaryRoot}/`;
	return resolved === boundaryRoot || `${resolved}/`.startsWith(boundaryPrefix);
}

function checkGlobBoundary(
	p: string,
	resolveCwd: string,
	boundaryCwd: string,
	access: PathAccess,
): CheckResult {
	const expanded = expandTilde(p);
	const { prefix } = splitGlobPattern(expanded);
	if (globLeavesPrefix(expanded)) {
		return block(
			`glob pattern ${JSON.stringify(p)} leaves the directory it expands from and cannot be verified against the working directory`,
		);
	}
	const resolvedPrefix = resolvePath(prefix, resolveCwd);
	if (resolvedPrefix === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	if (isSystemTempPath(resolvedPrefix)) {
		return SAFE;
	}
	if (isSkillPath(resolvedPrefix)) {
		if (access !== "read") {
			return block(
				`${JSON.stringify(p)} expands inside an installed skills directory (${resolvedPrefix}) — skills are read-only for the agent`,
			);
		}
		return SAFE;
	}
	if (isInsideBoundary(resolvedPrefix, boundaryCwd)) {
		return SAFE;
	}
	return block(
		`${JSON.stringify(p)} expands from ${JSON.stringify(resolvedPrefix)}, which is outside the working directory ${JSON.stringify(boundaryCwd)}`,
	);
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
	access: PathAccess = "read",
): CheckResult {
	if (hasShellVariable(p)) {
		return block(
			`path contains a variable that cannot be resolved statically: ${JSON.stringify(p)}`,
		);
	}
	if (hasGlobMagic(p)) {
		return checkGlobBoundary(p, resolveCwd, boundaryCwd, access);
	}
	const resolved = resolvePath(p, resolveCwd);
	if (resolved === null) {
		return block(`cannot safely resolve path: ${JSON.stringify(p)}`);
	}
	if (access === "redirect" && isNullDevice(resolved)) {
		return SAFE;
	}
	if (isSystemTempPath(resolved)) {
		return SAFE;
	}
	if (isSkillPath(resolved)) {
		if (access !== "read") {
			return block(
				`${JSON.stringify(p)} is inside an installed skills directory (${resolved}) — skills are read-only for the agent`,
			);
		}
		return SAFE;
	}
	if (isInsideBoundary(resolved, boundaryCwd)) {
		return SAFE;
	}
	return block(
		`${JSON.stringify(resolved)} is outside the working directory ${JSON.stringify(boundaryCwd)}`,
	);
}
