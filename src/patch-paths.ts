/**
 * Shared extraction of file paths written by patch-style tool inputs
 * (e.g. `apply_patch` diffs and Update File blocks).
 */

/**
 * Runs each regex over `patch`, collecting capture group 1, skipping `/dev/null`.
 * Each regex should expose the file path in its first capture group.
 */
export function extractPatchPaths(patch: string, expressions: readonly RegExp[]): string[] {
	const paths: string[] = [];
	for (const expression of expressions) {
		let match: RegExpExecArray | null;
		while ((match = expression.exec(patch)) !== null) {
			if (match[1] !== "/dev/null") paths.push(match[1]!);
		}
	}
	return paths;
}

/**
 * Reads a tool-call input's "this is the file being written" field by name.
 * Returning `undefined` means the tool does not name a single file.
 */
export type ExtraPathReader = (input: Record<string, unknown>) => string | undefined;

/**
 * Returns the paths a tool-call input would write. `extractPaths` turns a
 * patch string into the affected file paths (implementations differ per caller).
 * `extras` lists additional tools whose file path lives in a non-standard
 * input field, each reader tries until one returns a path.
 */
export function pathsWrittenByTool(
	toolName: string,
	input: Record<string, unknown>,
	extractPaths: (patch: string) => string[],
	extras: readonly { suffix: string; read: ExtraPathReader }[] = [],
): string[] {
	if (toolName === "write" || toolName === "edit") {
		return typeof input.path === "string" ? [input.path] : [];
	}

	if (toolName.endsWith("apply_patch")) {
		return [input.input, input.patch]
			.filter((value): value is string => typeof value === "string")
			.flatMap(extractPaths);
	}

	for (const { suffix, read } of extras) {
		if (toolName.endsWith(suffix)) {
			const path = read(input);
			if (path !== undefined) return [path];
		}
	}

	return [];
}