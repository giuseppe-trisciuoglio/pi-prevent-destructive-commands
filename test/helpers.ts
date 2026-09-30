/**
 * Shared helpers for the standalone test scripts. Does not depend on pi.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTokens, type CheckResult } from "../src/checker";
import { PROJECT_CONFIG_RELATIVE_PATH, resetProjectConfigCache } from "../src/project-config";
import { tokenize } from "../src/tokenizer";

export function check(name: string, actual: unknown, expected: unknown): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) {
		console.error(`✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
		throw new Error(`test failed: ${name}`);
	}
	console.log(`✓ ${name}`);
}

/** Creates a temp project dir, optionally writing the project config into it. */
export function makeProject(prefix: string, content?: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	if (content !== undefined) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), content);
	}
	resetProjectConfigCache();
	return dir;
}

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
	cases: CheckCase[],
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
	if (failed > 0) {
		process.exit(1);
	}
}
