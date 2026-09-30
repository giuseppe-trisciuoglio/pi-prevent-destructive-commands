/**
 * Shared extraction of file paths written by patch-style tool inputs
 * (e.g. `apply_patch` diffs and Update File blocks).
 */

/** Runs each global regex over `patch`, collecting capture group 1, skipping `/dev/null`. */
export function extractPatchPaths(patch: string, expressions: RegExp[]): string[] {
	const paths: string[] = [];
	for (const expression of expressions) {
		let match: RegExpExecArray | null;
		while ((match = expression.exec(patch)) !== null) {
			if (match[1] !== "/dev/null") paths.push(match[1]);
		}
	}
	return paths;
}

/**
 * Returns the paths a tool-call input would write. `extractPaths` turns a
 * patch string into the affected file paths (implementations differ per caller).
 */
export function pathsWrittenByTool(
	toolName: string,
	input: Record<string, unknown>,
	extractPaths: (patch: string) => string[],
): string[] {
	if (toolName === "write" || toolName === "edit") {
		return typeof input.path === "string" ? [input.path] : [];
	}

	if (toolName.endsWith("apply_patch")) {
		return [input.input, input.patch]
			.filter((value): value is string => typeof value === "string")
			.flatMap(extractPaths);
	}

	if (toolName.endsWith("rename_refactoring")) {
		return typeof input.pathInProject === "string" ? [input.pathInProject] : [];
	}

	return [];
}
