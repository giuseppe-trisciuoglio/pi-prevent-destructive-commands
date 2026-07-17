/** Detects path-sensitive commands (`rm`, `rmdir`, ...) targeting paths outside the cwd. */

import { SHELL_OPERATORS } from "../config";
import { isOutsideCwd } from "./path-utils";
import { type CheckResult, SAFE, block } from "./types";

export function checkPathSensitive(
	tokens: string[],
	i: number,
	token: string,
	cwd: string,
): CheckResult {
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg === "--") {
			j++;
			continue;
		}
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		const r = isOutsideCwd(arg, cwd);
		if (r.dangerous) {
			return block(
				`${JSON.stringify(token)} targets a path outside the working directory — ${r.reason}`,
			);
		}
		j++;
	}
	return SAFE;
}
