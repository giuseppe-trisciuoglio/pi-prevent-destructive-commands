/** Detects destructive Docker operations (`docker rm`, `docker system prune`, ...). */

import { DOCKER_DESTRUCTIVE_COMPOUND, DOCKER_DESTRUCTIVE_SUBCOMMANDS } from "../config";
import { type CheckResult, SAFE, block } from "./types";

export function checkDocker(tokens: string[], i: number): CheckResult {
	if (i + 1 >= tokens.length) return SAFE;
	const sub1 = tokens[i + 1];
	const rest = tokens.slice(i + 2);

	if (i + 2 < tokens.length) {
		const compound = `${sub1} ${tokens[i + 2]}`;
		if (DOCKER_DESTRUCTIVE_COMPOUND.has(compound)) {
			return block(`destructive Docker operation: docker ${compound}`);
		}
	}
	if (DOCKER_DESTRUCTIVE_SUBCOMMANDS.has(sub1)) {
		return block(`destructive Docker operation: docker ${sub1}`);
	}
	if (sub1 === "compose" && i + 2 < tokens.length) {
		const composeSub = tokens[i + 2];
		if (composeSub === "down" && rest.includes("-v")) {
			return block("docker compose down -v removes volumes with data loss risk");
		}
		if (composeSub === "rm") {
			return block("docker compose rm removes stopped containers");
		}
	}
	if (sub1 === "context" && i + 2 < tokens.length && tokens[i + 2] === "rm") {
		return block("docker context rm removes Docker contexts");
	}
	if (
		sub1 === "swarm" &&
		i + 2 < tokens.length &&
		tokens[i + 2] === "leave" &&
		rest.includes("--force")
	) {
		return block("docker swarm leave --force forcibly removes the node from the swarm");
	}
	return SAFE;
}
