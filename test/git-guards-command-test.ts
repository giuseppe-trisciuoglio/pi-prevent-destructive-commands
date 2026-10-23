/**
 * Tests for the `/git-guards` slash command (argument parsing, status,
 * opt-out file writes, handler wiring). Does not depend on the pi runtime:
 *   npx tsx test/git-guards-command-test.ts
 */

import { existsSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { registerGitGuardsCommand } from "../src/git-guards-command";
import {
	applyGitGuards,
	gitGuardsStatus,
	parseGitGuardsArgs,
} from "../src/git-guards-command";
import { PROJECT_CONFIG_RELATIVE_PATH, loadProjectConfig } from "../src/project-config";
import {
	check,
	checkFileStatusOnInvalidConfig,
	checkUnknownArgument,
	finishTest,
	isBlocked,
	makeProject,
	setupCommandHarness,
} from "./helpers";

// ─── parseGitGuardsArgs ───────────────────────────────────────────────────────

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

checkFileStatusOnInvalidConfig("git-guards", gitGuardsStatus, (status) => {
	check("invalid JSON → guards stay enabled", status.guardsEnabled, true);
});

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

	// Interactive-commit hang prevention: blocked even with guards off.
	check("guards off → bare git commit still blocked", isBlocked("git commit", empty, false), true);
	check("guards off → git commit -a still blocked", isBlocked("git commit -a", empty, false), true);
	check("guards off → git commit --amend still blocked", isBlocked("git commit --amend", empty, false), true);
	check("guards off → git commit --no-verify still blocked", isBlocked("git commit --no-verify", empty, false), true);
	check("guards off → git commit -am x allowed", isBlocked("git commit -am x", empty, false), false);
	check("guards off → git commit -F msg.txt allowed", isBlocked("git commit -F msg.txt", empty, false), false);
	check("guards off → git commit --amend --no-edit allowed", isBlocked("git commit --amend --no-edit", empty, false), false);
	check("guards off → git commit --message=x allowed", isBlocked("git commit --message=x", empty, false), false);
	check("guards on → bare git commit blocked", isBlocked("git commit", empty, true), true);
	check("guards on → git commit --amend blocked", isBlocked("git commit --amend", empty, true), true);

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

const commandProject = makeProject();
{
	const { handler, ctx, notifications } = setupCommandHarness(
		commandProject,
		"git-guards",
		(pi) => registerGitGuardsCommand(pi as unknown as Parameters<typeof registerGitGuardsCommand>[0]),
	);

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

	checkUnknownArgument(handler, ctx, notifications);
}
rmSync(commandProject, { recursive: true, force: true });

rmSync(noFile, { recursive: true, force: true });

finishTest("git-guards command");
