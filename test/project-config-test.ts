/**
 * Tests for the per-project opt-out file `.pi/prevent-destructive-commands.json`.
 * Does not depend on pi: can be run with:
 *   npx tsx test/project-config-test.ts
 */

import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTokens } from "../src/checker";
import {
	CONFIG_MUTATING_COMMAND,
	DEFAULT_PROJECT_CONFIG,
	PROJECT_CONFIG_RELATIVE_PATH,
	commandReferencesProjectConfig,
	loadProjectConfig,
	resetProjectConfigCache,
} from "../src/project-config";
import { tokenize } from "../src/tokenizer";

let failures = 0;

function check(name: string, actual: unknown, expected: unknown) {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (!ok) {
		failures++;
		console.error(`✗ ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	} else {
		console.log(`✓ ${name}`);
	}
}

function makeProject(content?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pdc-project-config-"));
	if (content !== undefined) {
		mkdirSync(join(dir, ".pi"), { recursive: true });
		writeFileSync(join(dir, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), content);
	}
	resetProjectConfigCache();
	return dir;
}

function isBlocked(command: string, cwd: string, gitGuardsEnabled: boolean): boolean {
	return checkTokens(tokenize(command), cwd, 0, false, cwd, { gitGuardsEnabled }).dangerous;
}

// ─── loadProjectConfig ───────────────────────────────────────────────────────

const missing = makeProject();
check("missing file → defaults (guards active)", loadProjectConfig(missing), DEFAULT_PROJECT_CONFIG);
rmSync(missing, { recursive: true, force: true });

const disabled = makeProject(JSON.stringify({ disableGitGuards: true }));
check("disableGitGuards: true", loadProjectConfig(disabled).disableGitGuards, true);

const enabled = makeProject(JSON.stringify({ disableGitGuards: false }));
check("disableGitGuards: false", loadProjectConfig(enabled).disableGitGuards, false);
rmSync(enabled, { recursive: true, force: true });

const invalid = makeProject("{ not json");
check("invalid JSON → defaults (guards active)", loadProjectConfig(invalid), DEFAULT_PROJECT_CONFIG);
rmSync(invalid, { recursive: true, force: true });

const otherKeys = makeProject(JSON.stringify({ somethingElse: true }));
check("unrelated keys → defaults (guards active)", loadProjectConfig(otherKeys), DEFAULT_PROJECT_CONFIG);
rmSync(otherKeys, { recursive: true, force: true });

// Manual edit is picked up through the mtime-based cache.
writeFileSync(
	join(disabled, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")),
	JSON.stringify({ disableGitGuards: false }),
);
// mtime resolution can be coarse on some filesystems: force a distinct mtime.
const future = new Date(Date.now() + 2000);
utimesSync(join(disabled, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), future, future);
check("manual edit invalidates cache", loadProjectConfig(disabled).disableGitGuards, false);
rmSync(disabled, { recursive: true, force: true });

// ─── Guard behavior with the option on/off ───────────────────────────────────

const GUARDS_ON = { cwd: "/home/user/projects/demo", enabled: true };
const GUARDS_OFF = { cwd: "/home/user/projects/demo", enabled: false };

for (const [label, { cwd, enabled }] of [
	["guards enabled", GUARDS_ON],
	["guards disabled", GUARDS_OFF],
] as const) {
	check(`${label}: git add`, isBlocked("git add .", cwd, enabled), enabled);
	check(`${label}: git commit`, isBlocked("git commit -m wip", cwd, enabled), enabled);
	check(`${label}: git push`, isBlocked("git push origin main", cwd, enabled), enabled);
	check(`${label}: git -C push`, isBlocked("git -C /tmp/repo push origin main", cwd, enabled), enabled);
	// Destructive push variants stay blocked in both modes.
	check(`${label}: git push --force`, isBlocked("git push --force origin main", cwd, enabled), true);
	check(`${label}: git push --force-with-lease`, isBlocked("git push --force-with-lease", cwd, enabled), true);
	check(`${label}: git push --delete`, isBlocked("git push --delete origin feature", cwd, enabled), true);
	// Other git guards are unaffected by the option.
	check(`${label}: git reset --hard`, isBlocked("git reset --hard", cwd, enabled), true);
	check(`${label}: git rebase`, isBlocked("git rebase main", cwd, enabled), true);
	check(`${label}: git status`, isBlocked("git status", cwd, enabled), false);
}

// ─── The agent cannot create/modify the config file via bash ─────────────────

const mutating = [
	`echo '{"disableGitGuards":true}' > ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`echo x >> ./${PROJECT_CONFIG_RELATIVE_PATH}`,
	`tee ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`touch ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`rm ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`cp other.json ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`sed -i s/true/false/ ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`chmod 644 ${PROJECT_CONFIG_RELATIVE_PATH}`,
];
for (const command of mutating) {
	check(
		`bash mutation blocked: ${command}`,
		CONFIG_MUTATING_COMMAND.test(command) && commandReferencesProjectConfig(command),
		true,
	);
}

const harmless = [
	`cat ${PROJECT_CONFIG_RELATIVE_PATH}`,
	`ls .pi`,
	`echo '{"disableGitGuards":true}'`,
	"git status",
];
for (const command of harmless) {
	check(
		`harmless command allowed: ${command}`,
		CONFIG_MUTATING_COMMAND.test(command) && commandReferencesProjectConfig(command),
		false,
	);
}

console.log(failures === 0 ? "\nAll project-config tests passed." : `\n${failures} test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
