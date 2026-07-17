/** Detects file-reading commands targeting sensitive files (`.env`, SSH keys, credentials). */

import { ENABLE_SENSITIVE_FILE_CHECK, SENSITIVE_FILE_PATTERNS, SHELL_OPERATORS } from "../config";
import { type CheckResult, SAFE, block } from "./types";

export function checkFileReading(tokens: string[], i: number): CheckResult {
	if (!ENABLE_SENSITIVE_FILE_CHECK) return SAFE;
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		const argLower = arg.toLowerCase();
		for (const pattern of SENSITIVE_FILE_PATTERNS) {
			if (argLower.includes(pattern) || argLower.endsWith(pattern)) {
				return block(`attempt to read sensitive file: ${JSON.stringify(arg)}`);
			}
		}
		j++;
	}
	return SAFE;
}
