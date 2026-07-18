/**
 * Shared result type for the recursive checker and its per-category rule
 * handlers (git, docker, aws, file-reading, path-sensitive).
 */

export interface CheckResult {
	dangerous: boolean;
	reason: string;
}

export const SAFE: CheckResult = { dangerous: false, reason: "" };

export function block(reason: string): CheckResult {
	return { dangerous: true, reason };
}
