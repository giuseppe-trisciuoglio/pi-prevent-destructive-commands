/**
 * Tests for the `/git-guards` slash command (argument parsing, status,
 * opt-out file writes, handler wiring). Does not depend on the pi runtime:
 *   npx tsx test/git-guards-command-test.ts
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkTokens } from "../src/checker";
import { registerGitGuardsCommand } from "../src/git-guards-command";
import {
	applyGitGuards,
	gitGuardsStatus,
	parseGitGuardsArgs,
} from "../src/git-guards-command";
import {
	PROJECT_CONFIG_RELATIVE_PATH,
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
	const dir = mkdtempSync(join(tmpdir(), "pdc-git-guards-cmd-"));
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

// ─── parseGitGuardsArgs ──────────────────────────────────────────────────────

check("no args → status", parseGitGuardsArgs(""), "status");
check("'  ' → status", parseGitGuardsArgs("   "), "status");
check("'status' → status", parseGitGuardsArgs("status"), "status");
check("'STATUS' → status (case-insensitive)", parseGitGuardsArgs("STATUS"), "status");
check("'off' → off", parseGitGuardsArgs("off"), "off");
check("'disable' → off (alias)", parseGitGuardsArgs("disable"), "off");
check("'on' → on", parseGitGuardsArgs("on"), "on");
check("'enable' → on (alias)", parseGitGuardsArgs("enable"), "on");
check("'foo' → usage", parseGitGuardsArgs("foo"), "usage");

// ─── gitGuardsStatus ─────────────────────────────────────────────────────────

const noFile = makeProject();
{
	const status = gitGuardsStatus(noFile);
	check("missing file → guards enabled", status.guardsEnabled, true);
	check("missing file → fileExists false", status.fileExists, false);
	check("missing file → fileValid true (not invalid)", status.fileValid, true);
	check("missing file → not disabled globally", status.disabledGlobally, false);
}

const disabledFile = makeProject('{"disableGitGuards": true}');
{
	const status = gitGuardsStatus(disabledFile);
	check("disableGitGuards: true → guards disabled", status.guardsEnabled, false);
	check("disableGitGuards: true → file exists", status.fileExists, true);
	check("disableGitGuards: true → file valid", status.fileValid, true);
	check("disableGitGuards: true → not a global disable", status.disabledGlobally, false);
}
rmSync(disabledFile, { recursive: true, force: true });

const invalidFile = makeProject("{ not json");
{
	const status = gitGuardsStatus(invalidFile);
	check("invalid JSON → guards stay enabled", status.guardsEnabled, true);
	check("invalid JSON → fileExists true", status.fileExists, true);
	check("invalid JSON → fileValid false", status.fileValid, false);
}
rmSync(invalidFile, { recursive: true, force: true });

// ─── applyGitGuards ──────────────────────────────────────────────────────────

const empty = makeProject();
{
	const replacedInvalid = applyGitGuards(empty, true);
	check("off on missing file → no 'replaced invalid' flag", replacedInvalid, false);
	check("off creates the file", existsSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/"))), true);
	const raw: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("off writes disableGitGuards: true", (raw as Record<string, unknown>).disableGitGuards, true);
	check("off effect visible via loadProjectConfig", loadProjectConfig(empty).disableGitGuards, true);

	// End-to-end guard behavior with the new state.
	check("guards off → git commit allowed", isBlocked("git commit -m x", empty, false), false);
	check("guards off → git push allowed", isBlocked("git push", empty, false), false);
	check("guards off → git push --force still blocked", isBlocked("git push --force", empty, false), true);
	check("guards off → git reset --hard still blocked", isBlocked("git reset --hard", empty, false), true);

	// Add an unrelated key, then toggle on: the key must survive.
	writeFileSync(
		join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")),
		'{"disableGitGuards": true, "futureOption": 42}',
	);
	applyGitGuards(empty, false);
	const merged: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("on writes disableGitGuards: false", (merged as Record<string, unknown>).disableGitGuards, false);
	check("on preserves unrelated keys", (merged as Record<string, unknown>).futureOption, 42);
	check("on effect visible via loadProjectConfig", loadProjectConfig(empty).disableGitGuards, false);
	check("guards on → git commit blocked again", isBlocked("git commit -m x", empty, true), true);
}
rmSync(empty, { recursive: true, force: true });

const broken = makeProject("{ not json");
{
	const replacedInvalid = applyGitGuards(broken, true);
	check("off on invalid file → reports replacement", replacedInvalid, true);
	const status = gitGuardsStatus(broken);
	check("invalid file normalized after off", status.fileValid, true);
	check("normalized file → guards disabled", status.guardsEnabled, false);
}
rmSync(broken, { recursive: true, force: true });

// ─── registerGitGuardsCommand (handler wiring with a fake pi/ctx) ───────────

interface RecordedNotification {
	message: string;
	type: string;
}

function fakePi() {
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	return {
		commands,
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		},
	};
}

function fakeCtx(cwd: string) {
	const notifications: RecordedNotification[] = [];
	return {
		notifications,
		ctx: { cwd, ui: { notify: (message: string, type = "info") => notifications.push({ message, type }) } },
	};
}

const commandProject = makeProject();
{
	const pi = fakePi();
	registerGitGuardsCommand(pi as unknown as Parameters<typeof registerGitGuardsCommand>[0]);
	check("command registered as git-guards", pi.commands.has("git-guards"), true);
	check("command has a description", typeof pi.commands.get("git-guards")?.description, "string");

	const handler = pi.commands.get("git-guards")!.handler;
	const { ctx, notifications } = fakeCtx(commandProject);

	ctx.cwd = commandProject;
	handler("", ctx);
	check("status notifies once", notifications.length, 1);
	check("status mentions ACTIVE", notifications[0].message.includes("ACTIVE"), true);
	check("status mentions missing file", notifications[0].message.includes("missing"), true);

	handler("off", ctx);
	check("off notifies once", notifications.length, 2);
	check("off notification is a warning", notifications[1].type, "warning");
	check("off effect via loadProjectConfig", loadProjectConfig(commandProject).disableGitGuards, true);

	handler("", ctx);
	check("status after off mentions DISABLED", notifications[2].message.includes("DISABLED"), true);

	handler("on", ctx);
	check("on notifies once", notifications.length, 4);
	check("on effect via loadProjectConfig", loadProjectConfig(commandProject).disableGitGuards, false);

	handler("bogus", ctx);
	check("unknown arg notifies once", notifications.length, 5);
	check("unknown arg shows usage", notifications[4].message.includes("Usage:"), true);
	check("unknown arg notification is an error", notifications[4].type, "error");
}
rmSync(commandProject, { recursive: true, force: true });

// ─── result ──────────────────────────────────────────────────────────────────

rmSync(noFile, { recursive: true, force: true });

if (failures > 0) {
	console.error(`\n${failures} git-guards command test(s) failed.`);
	process.exit(1);
} else {
	console.log("\nAll git-guards command tests passed.");
}
