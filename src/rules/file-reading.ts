/** Detects file-reading commands targeting sensitive files (`.env`, SSH keys, credentials). */

import { ENABLE_SENSITIVE_FILE_CHECK, SENSITIVE_FILE_PATTERNS } from "../config";
import { forEachPositionalArg } from "./args";
import { type CheckResult, SAFE, block } from "./types";

export function checkFileReading(tokens: string[], i: number): CheckResult {
	if (!ENABLE_SENSITIVE_FILE_CHECK) return SAFE;
	let violation: CheckResult | undefined;
	forEachPositionalArg(tokens, i, (arg) => {
		const argLower = arg.toLowerCase();
		for (const pattern of SENSITIVE_FILE_PATTERNS) {
			if (argLower.includes(pattern) || argLower.endsWith(pattern)) {
				violation = block(`attempt to read sensitive file: ${JSON.stringify(arg)}`);
				return false;
			}
		}
	});
	return violation ?? SAFE;
}
