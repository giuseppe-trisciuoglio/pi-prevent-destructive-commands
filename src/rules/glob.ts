const GLOB_MAGIC = /[*?[]/;
const SHELL_VARIABLE = /\$[{(]?/;

export function hasGlobMagic(p: string): boolean {
	return GLOB_MAGIC.test(p);
}

export function hasShellVariable(p: string): boolean {
	return SHELL_VARIABLE.test(p) || p === "{}";
}

export interface GlobPattern {
	prefix: string;
	rest: string;
}

function firstMagicIndex(pattern: string): number {
	for (let i = 0; i < pattern.length; i++) {
		if (GLOB_MAGIC.test(pattern[i]!)) return i;
	}
	return -1;
}

export function splitGlobPattern(pattern: string): GlobPattern {
	const magicIndex = firstMagicIndex(pattern);
	if (magicIndex === -1) return { prefix: pattern, rest: "" };
	const slashIndex = pattern.lastIndexOf("/", magicIndex);
	if (slashIndex === -1) return { prefix: "", rest: pattern };
	const prefix = pattern.slice(0, slashIndex);
	return {
		prefix: prefix === "" && pattern.startsWith("/") ? "/" : prefix,
		rest: pattern.slice(slashIndex + 1),
	};
}

export function globLeavesPrefix(pattern: string): boolean {
	const { rest } = splitGlobPattern(pattern);
	return rest.split("/").includes("..");
}

