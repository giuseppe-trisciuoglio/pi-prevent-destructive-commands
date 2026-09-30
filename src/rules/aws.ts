/** Detects destructive AWS CLI operations (`aws s3 rm`, `aws ec2 terminate-instances`, ...). */

import { AWS_DESTRUCTIVE_SUBCOMMANDS } from "../config";
import { collectPositionalParts, matchLongestSubcommand } from "./args";
import { type CheckResult, SAFE, block } from "./types";

export function checkAws(tokens: string[], i: number): CheckResult {
	let j = i + 1;
	while (j < tokens.length && tokens[j].startsWith("--")) j++;
	const parts = collectPositionalParts(tokens, j, 3);
	const sub = matchLongestSubcommand(parts, AWS_DESTRUCTIVE_SUBCOMMANDS);
	if (sub !== null) {
		return block(`destructive AWS CLI operation: aws ${sub}`);
	}
	return SAFE;
}
