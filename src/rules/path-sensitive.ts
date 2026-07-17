/** Detects path-sensitive commands (`rm`, `rmdir`, ...) targeting paths outside the cwd. */

import { SHELL_OPERATORS } from "../config";
import { isOutsideCwd } from "./path-utils";
import { type CheckResult, SAFE, block } from "./types";

/**
 * @param resolveCwd Directory relative targets resolve against (tracks a preceding `cd`).
 * @param boundaryCwd Fixed real working directory targets must stay inside.
 * @param stdinArgs When `true`, this command was reached through `xargs`/`parallel`
 *   delegation: if no explicit target token is found, the real arguments arrive via
 *   stdin at runtime and can't be statically verified, so that case is blocked too
 *   instead of being treated as a harmless no-op.
 */
export function checkPathSensitive(
	tokens: string[],
	i: number,
	token: string,
	resolveCwd: string,
	boundaryCwd: string = resolveCwd,
	stdinArgs = false,
): CheckResult {
	let j = i + 1;
	let hasExplicitTarget = false;
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
		hasExplicitTarget = true;
		const r = isOutsideCwd(arg, resolveCwd, boundaryCwd);
		if (r.dangerous) {
			return block(
				`${JSON.stringify(token)} targets a path outside the working directory — ${r.reason}`,
			);
		}
		j++;
	}
	if (!hasExplicitTarget && stdinArgs) {
		return block(
			`${JSON.stringify(token)} receives its arguments via a pipe/xargs — the actual targets are not visible as tokens and cannot be verified against the working directory`,
		);
	}
	return SAFE;
}
