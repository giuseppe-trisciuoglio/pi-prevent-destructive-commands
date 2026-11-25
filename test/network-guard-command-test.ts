import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	NETWORK_GUARD_USAGE,
	applyNetworkGuard,
	parseNetworkGuardArgs,
	registerNetworkGuardCommand,
	networkGuardStatus,
} from "../src/network-guard-command";
import { PROJECT_CONFIG_RELATIVE_PATH, loadProjectConfig } from "../src/project-config";
import {
	check,
	checkFileStatusOnInvalidConfig,
	checkUnknownArgument,
	finishTest,
	makeProject,
	setupCommandHarness,
} from "./helpers";

check("no args -> status", parseNetworkGuardArgs(""), "status");
check("blank -> status", parseNetworkGuardArgs("   "), "status");
check("status -> status", parseNetworkGuardArgs("status"), "status");
check("STATUS -> status", parseNetworkGuardArgs("STATUS"), "status");
check("on -> on", parseNetworkGuardArgs("on"), "on");
check("enable -> on", parseNetworkGuardArgs("enable"), "on");
check("off -> off", parseNetworkGuardArgs("off"), "off");
check("disable -> off", parseNetworkGuardArgs("disable"), "off");
check("bogus -> usage", parseNetworkGuardArgs("bogus"), "usage");

const noFile = makeProject();
{
	const status = networkGuardStatus(noFile);
	check("missing file -> guard enabled", status.guardEnabled, true);
	check("missing file -> fileExists false", status.fileExists, false);
	check("missing file -> fileValid true", status.fileValid, true);
}

const disabledFile = makeProject('{"disableNetworkGuard": true}');
{
	const status = networkGuardStatus(disabledFile);
	check("disableNetworkGuard true -> guard disabled", status.guardEnabled, false);
	check("disableNetworkGuard true -> fileExists true", status.fileExists, true);
	check("disableNetworkGuard true -> fileValid true", status.fileValid, true);
}
rmSync(disabledFile, { recursive: true, force: true });

checkFileStatusOnInvalidConfig("network-guard", networkGuardStatus, (status) => {
	check("invalid JSON -> guard enabled", status.guardEnabled, true);
});

const empty = makeProject();
{
	const replacedInvalid = applyNetworkGuard(empty, true);
	check("off on missing file -> no replaced-invalid flag", replacedInvalid, false);
	check("off creates the file", existsSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/"))), true);
	const raw: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("off writes disableNetworkGuard: true", (raw as Record<string, unknown>).disableNetworkGuard, true);
	check("off visible via loadProjectConfig", loadProjectConfig(empty).disableNetworkGuard, true);

	writeFileSync(
		join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")),
		'{"readOnly": true, "futureOption": 42}',
	);
	applyNetworkGuard(empty, false);
	const merged: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("on writes disableNetworkGuard: false", (merged as Record<string, unknown>).disableNetworkGuard, false);
	check("on preserves readOnly", (merged as Record<string, unknown>).readOnly, true);
	check("on preserves unrelated keys", (merged as Record<string, unknown>).futureOption, 42);
	check("on visible via loadProjectConfig", loadProjectConfig(empty).disableNetworkGuard, false);
}
rmSync(empty, { recursive: true, force: true });

const broken = makeProject("{ not json");
{
	const replacedInvalid = applyNetworkGuard(broken, true);
	check("off on invalid file -> reports replacement", replacedInvalid, true);
	const status = networkGuardStatus(broken);
	check("invalid file normalized after off", status.fileValid, true);
	check("normalized file -> guard disabled", status.guardEnabled, false);
}
rmSync(broken, { recursive: true, force: true });

const commandProject = makeProject();
{
	const { handler, ctx, notifications } = setupCommandHarness(
		commandProject,
		"network-guard",
		(pi) => registerNetworkGuardCommand(pi as unknown as Parameters<typeof registerNetworkGuardCommand>[0]),
	);

	handler("", ctx);
	check("status notifies once", notifications.length, 1);
	check("status mentions ACTIVE", notifications[0].message.includes("ACTIVE"), true);
	check("status mentions missing file", notifications[0].message.includes("missing"), true);

	handler("off", ctx);
	check("off notifies once", notifications.length, 2);
	check("off notification is a warning", notifications[1].type, "warning");
	check("off effect via loadProjectConfig", loadProjectConfig(commandProject).disableNetworkGuard, true);

	handler("", ctx);
	check("status after off mentions INACTIVE", notifications[2].message.includes("INACTIVE"), true);

	handler("on", ctx);
	check("on notifies once", notifications.length, 4);
	check("on effect via loadProjectConfig", loadProjectConfig(commandProject).disableNetworkGuard, false);

	checkUnknownArgument(handler, ctx, notifications);
	check("usage documents the off form", NETWORK_GUARD_USAGE.includes("/network-guard [on|off|status]"), true);
}
rmSync(commandProject, { recursive: true, force: true });

rmSync(noFile, { recursive: true, force: true });

finishTest("network-guard command");
