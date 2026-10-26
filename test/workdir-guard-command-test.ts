import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	WORKDIR_GUARD_USAGE,
	applyWorkdirGuard,
	parseWorkdirGuardArgs,
	registerWorkdirGuardCommand,
	workdirGuardStatus,
} from "../src/workdir-guard-command";
import { PROJECT_CONFIG_RELATIVE_PATH, loadProjectConfig } from "../src/project-config";
import {
	check,
	checkFileStatusOnInvalidConfig,
	checkUnknownArgument,
	finishTest,
	makeProject,
	setupCommandHarness,
} from "./helpers";

check("no args -> status", parseWorkdirGuardArgs(""), "status");
check("blank -> status", parseWorkdirGuardArgs("   "), "status");
check("status -> status", parseWorkdirGuardArgs("status"), "status");
check("STATUS -> status", parseWorkdirGuardArgs("STATUS"), "status");
check("on -> on", parseWorkdirGuardArgs("on"), "on");
check("enable -> on", parseWorkdirGuardArgs("enable"), "on");
check("off -> off", parseWorkdirGuardArgs("off"), "off");
check("disable -> off", parseWorkdirGuardArgs("disable"), "off");
check("bogus -> usage", parseWorkdirGuardArgs("bogus"), "usage");

const noFile = makeProject();
{
	const status = workdirGuardStatus(noFile);
	check("missing file -> guard enabled", status.guardEnabled, true);
	check("missing file -> fileExists false", status.fileExists, false);
	check("missing file -> fileValid true", status.fileValid, true);
}

const disabledFile = makeProject('{"disableWorkdirGuard": true}');
{
	const status = workdirGuardStatus(disabledFile);
	check("disableWorkdirGuard true -> guard disabled", status.guardEnabled, false);
	check("disableWorkdirGuard true -> fileExists true", status.fileExists, true);
	check("disableWorkdirGuard true -> fileValid true", status.fileValid, true);
}
rmSync(disabledFile, { recursive: true, force: true });

checkFileStatusOnInvalidConfig("workdir-guard", workdirGuardStatus, (status) => {
	check("invalid JSON -> guard enabled", status.guardEnabled, true);
});

const empty = makeProject();
{
	const replacedInvalid = applyWorkdirGuard(empty, true);
	check("off on missing file -> no replaced-invalid flag", replacedInvalid, false);
	check("off creates the file", existsSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/"))), true);
	const raw: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("off writes disableWorkdirGuard: true", (raw as Record<string, unknown>).disableWorkdirGuard, true);
	check("off visible via loadProjectConfig", loadProjectConfig(empty).disableWorkdirGuard, true);

	writeFileSync(
		join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")),
		'{"readOnly": true, "futureOption": 42}',
	);
	applyWorkdirGuard(empty, false);
	const merged: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("on writes disableWorkdirGuard: false", (merged as Record<string, unknown>).disableWorkdirGuard, false);
	check("on preserves readOnly", (merged as Record<string, unknown>).readOnly, true);
	check("on preserves unrelated keys", (merged as Record<string, unknown>).futureOption, 42);
	check("on visible via loadProjectConfig", loadProjectConfig(empty).disableWorkdirGuard, false);
}
rmSync(empty, { recursive: true, force: true });

const broken = makeProject("{ not json");
{
	const replacedInvalid = applyWorkdirGuard(broken, true);
	check("off on invalid file -> reports replacement", replacedInvalid, true);
	const status = workdirGuardStatus(broken);
	check("invalid file normalized after off", status.fileValid, true);
	check("normalized file -> guard disabled", status.guardEnabled, false);
}
rmSync(broken, { recursive: true, force: true });

const commandProject = makeProject();
{
	const { handler, ctx, notifications } = setupCommandHarness(
		commandProject,
		"workdir-guard",
		(pi) => registerWorkdirGuardCommand(pi as unknown as Parameters<typeof registerWorkdirGuardCommand>[0]),
	);

	handler("", ctx);
	check("status notifies once", notifications.length, 1);
	check("status mentions ACTIVE", notifications[0].message.includes("ACTIVE"), true);
	check("status mentions missing file", notifications[0].message.includes("missing"), true);

	handler("off", ctx);
	check("off notifies once", notifications.length, 2);
	check("off notification is a warning", notifications[1].type, "warning");
	check("off effect via loadProjectConfig", loadProjectConfig(commandProject).disableWorkdirGuard, true);

	handler("", ctx);
	check("status after off mentions INACTIVE", notifications[2].message.includes("INACTIVE"), true);

	handler("on", ctx);
	check("on notifies once", notifications.length, 4);
	check("on effect via loadProjectConfig", loadProjectConfig(commandProject).disableWorkdirGuard, false);

	checkUnknownArgument(handler, ctx, notifications);
	check("usage documents the off form", WORKDIR_GUARD_USAGE.includes("/workdir-guard [on|off|status]"), true);
}
rmSync(commandProject, { recursive: true, force: true });

rmSync(noFile, { recursive: true, force: true });

finishTest("workdir-guard command");
