/**
 * Shared helpers for the standalone test scripts. Does not depend on pi.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTokens, type CheckResult } from "../src/checker";
import { PROJECT_CONFIG_RELATIVE_PATH, resetProjectConfigCache } from "../src/project-config";
import { tokenize } from "../src/tokenizer";

/**
 * Compares two values via `JSON.stringify` and either prints `✓ name` on
 * success or `✗ name: expected … got …` on mismatch. Failures are counted
 * process-wide; scripts read the total with `checkFailures()` at the end.
 */
let checkFailuresCount = 0;

export function check(name: string, actual: unknown, expected: unknown): boolean {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`✓ ${name}`);
	} else {
		checkFailuresCount++;
		console.error(`✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
	return ok;
}

/** Number of failed `check` calls so far in this process. */
export function checkFailures(): number {
	return checkFailuresCount;
}

/** Creates a temp project dir, optionally writing the project config into it. */
export function makeProject(content?: string, prefix = "pdc-test-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	if (content !== undefined) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), content);
	}
	resetProjectConfigCache();
	return dir;
}

/**
 * Runs a command through the destructive-command checker for a given cwd and
 * returns whether it was blocked. Mirrors what the `tool_call` handler does
 * for `bash` tool calls so opt-out flags can be unit-tested end-to-end.
 */
export function isBlocked(command: string, cwd: string, gitGuardsEnabled: boolean): boolean {
	return checkTokens(tokenize(command), cwd, 0, false, cwd, { gitGuardsEnabled }).dangerous;
}

export interface CheckCase {
	command: string;
	expectBlocked: boolean;
	note?: string;
}

/**
 * Runs each case through `run`, prints PASS/FAIL lines and a summary, and
 * exits with status 1 when any case fails. `label` renders the command for
 * output (e.g. first line only for multi-line heredoc commands).
 */
export function runCheckCases(
	cases: readonly CheckCase[],
	run: (command: string) => CheckResult,
	label: (command: string) => string = (command) => command,
): void {
	let passed = 0;
	let failed = 0;

	for (const c of cases) {
		const result = run(c.command);
		const blocked = result.dangerous;
		const ok = blocked === c.expectBlocked;
		const status = ok ? "PASS" : "FAIL";
		if (ok) passed++;
		else failed++;
		const tag = c.expectBlocked ? "block " : "allow";
		const note = c.note ? `  (${c.note})` : "";
		const reason = blocked && !ok ? `  -> ${result.reason}` : "";
		console.log(`${status}  [${tag}]  ${label(c.command)}${note}${reason}`);
	}

	console.log("");
	console.log(`Result: ${passed} passed, ${failed} failed out of ${cases.length} cases.`);
	if (failed > 0) process.exit(1);
}

/**
 * Runs an assertion-style test in its own temp directory and cleans up
 * afterward. Prints `PASS  <name>` on success. Catches rejections and exits
 * the process with status 1 so a single failure short-circuits the run, like
 * the test scripts already did.
 */
export async function runIsolatedTest(name: string, body: (root: string) => Promise<void>): Promise<void> {
	async function main(): Promise<void> {
		const root = mkdtempSync(join(tmpdir(), "pdc-isolated-"));
		try {
			await body(root);
			console.log(`PASS  ${name}`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	main().catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}