/** Detects destructive AWS CLI operations (`aws s3 rm`, `aws ec2 terminate-instances`, ...). */

import { AWS_DESTRUCTIVE_SUBCOMMANDS } from "../config";
import { type CheckResult, SAFE, block } from "./types";

export function checkAws(tokens: string[], i: number): CheckResult {
	const parts: string[] = [];
	let j = i + 1;
	while (j < tokens.length && tokens[j].startsWith("--")) j++;
	while (j < tokens.length && !tokens[j].startsWith("-") && parts.length < 3) {
		parts.push(tokens[j]);
		j++;
	}
	for (let length = parts.length; length > 0; length--) {
		const sub = parts.slice(0, length).join(" ");
		if (AWS_DESTRUCTIVE_SUBCOMMANDS.has(sub)) {
			return block(`destructive AWS CLI operation: aws ${sub}`);
		}
	}
	return SAFE;
}
