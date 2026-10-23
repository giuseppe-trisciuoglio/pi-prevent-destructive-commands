import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	READ_ONLY_BLOCK_REASON,
	applyReadOnly,
	isReadOnlyMutatingTool,
	parseReadOnlyArgs,
	readOnlyBlockResult,
	readOnlyStatus,
	registerReadOnlyCommand,
} from "../src/read-only-command";
import { PROJECT_CONFIG_RELATIVE_PATH, loadProjectConfig } from "../src/project-config";
import { check, checkFailures, makeProject } from "./helpers";

check("no args → status", parseReadOnlyArgs(""), "status");
check("'  ' → status", parseReadOnlyArgs("   "), "status");
check("'status' → status", parseReadOnlyArgs("status"), "status");
check("'STATUS' → status (case-insensitive)", parseReadOnlyArgs("STATUS"), "status");
check("'on' → on", parseReadOnlyArgs("on"), "on");
check("'off' → off", parseReadOnlyArgs("off"), "off");
check("'foo' → usage", parseReadOnlyArgs("foo"), "usage");
check("'true' → usage", parseReadOnlyArgs("true"), "usage");

const noFile = makeProject();
{
	const status = readOnlyStatus(noFile);
	check("missing file → readOnly false", status.readOnly, false);
	check("missing file → fileExists false", status.fileExists, false);
	check("missing file → fileValid true", status.fileValid, true);
}

const enabledFile = makeProject('{"readOnly": true}');
{
	const status = readOnlyStatus(enabledFile);
	check("readOnly: true → readOnly true", status.readOnly, true);
	check("readOnly: true → fileExists true", status.fileExists, true);
	check("readOnly: true → fileValid true", status.fileValid, true);
}
rmSync(enabledFile, { recursive: true, force: true });

const invalidFile = makeProject("{ not json");
{
	const status = readOnlyStatus(invalidFile);
	check("invalid JSON → readOnly false", status.readOnly, false);
	check("invalid JSON → fileExists true", status.fileExists, true);
	check("invalid JSON → fileValid false", status.fileValid, false);
}
rmSync(invalidFile, { recursive: true, force: true });

const empty = makeProject();
{
	const replacedInvalid = applyReadOnly(empty, true);
	check("on on missing file → no replaced-invalid flag", replacedInvalid, false);
	check("on creates the file", existsSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/"))), true);
	const raw: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("on writes readOnly: true", (raw as Record<string, unknown>).readOnly, true);
	check("on visible via loadProjectConfig", loadProjectConfig(empty).readOnly, true);

	writeFileSync(
		join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")),
		'{"disableGitGuards": true, "futureOption": 42}',
	);
	applyReadOnly(empty, false);
	const merged: unknown = JSON.parse(readFileSync(join(empty, ...PROJECT_CONFIG_RELATIVE_PATH.split("/")), "utf8"));
	check("off writes readOnly: false", (merged as Record<string, unknown>).readOnly, false);
	check("off preserves disableGitGuards", (merged as Record<string, unknown>).disableGitGuards, true);
	check("off preserves unrelated keys", (merged as Record<string, unknown>).futureOption, 42);
	check("off visible via loadProjectConfig", loadProjectConfig(empty).readOnly, false);
}
rmSync(empty, { recursive: true, force: true });

const broken = makeProject("{ not json");
{
	const replacedInvalid = applyReadOnly(broken, true);
	check("on on invalid file → reports replacement", replacedInvalid, true);
	const status = readOnlyStatus(broken);
	check("invalid file normalized after on", status.fileValid, true);
	check("normalized file → readOnly true", status.readOnly, true);
}
rmSync(broken, { recursive: true, force: true });

check("write is mutating", isReadOnlyMutatingTool("write"), true);
check("edit is mutating", isReadOnlyMutatingTool("edit"), true);
check("apply_patch is mutating", isReadOnlyMutatingTool("apply_patch"), true);
check("custom apply_patch variant is mutating", isReadOnlyMutatingTool("smart_apply_patch"), true);
check("bash is mutating", isReadOnlyMutatingTool("bash"), true);
check("powershell is mutating", isReadOnlyMutatingTool("powershell"), true);
check("read is read-only", isReadOnlyMutatingTool("read"), false);
check("grep is read-only", isReadOnlyMutatingTool("grep"), false);
check("find is read-only", isReadOnlyMutatingTool("find"), false);
check("ls is read-only", isReadOnlyMutatingTool("ls"), false);

check("read-only off → write not blocked", readOnlyBlockResult("write", { readOnly: false }), undefined);
check(
	"read-only on → write blocked",
	readOnlyBlockResult("write", { readOnly: true }),
	{ block: true, reason: READ_ONLY_BLOCK_REASON },
);
check(
	"read-only on → bash blocked",
	readOnlyBlockResult("bash", { readOnly: true }),
	{ block: true, reason: READ_ONLY_BLOCK_REASON },
);
check("read-only on → read allowed", readOnlyBlockResult("read", { readOnly: true }), undefined);
check("block reason identifies the cause", READ_ONLY_BLOCK_REASON.includes("read-only mode is enabled"), true);

const readOnlyProject = makeProject('{"readOnly": true, "disableGitGuards": true}');
{
	check("read-only project config loads readOnly", loadProjectConfig(readOnlyProject).readOnly, true);
	check("read-only project still parses other keys", loadProjectConfig(readOnlyProject).disableGitGuards, true);
	check(
		"matrix: write blocked in read-only project",
		readOnlyBlockResult("write", loadProjectConfig(readOnlyProject)),
		{ block: true, reason: READ_ONLY_BLOCK_REASON },
	);
}
rmSync(readOnlyProject, { recursive: true, force: true });

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
	registerReadOnlyCommand(pi as unknown as Parameters<typeof registerReadOnlyCommand>[0]);
	check("command registered as read-only", pi.commands.has("read-only"), true);
	check("command has a description", typeof pi.commands.get("read-only")?.description, "string");

	const handler = pi.commands.get("read-only")!.handler;
	const { ctx, notifications } = fakeCtx(commandProject);

	ctx.cwd = commandProject;
	handler("", ctx);
	check("status notifies once", notifications.length, 1);
	check("status mentions INACTIVE", notifications[0].message.includes("INACTIVE"), true);
	check("status mentions missing file", notifications[0].message.includes("missing"), true);

	handler("on", ctx);
	check("on notifies once", notifications.length, 2);
	check("on notification is a warning", notifications[1].type, "warning");
	check("on effect via loadProjectConfig", loadProjectConfig(commandProject).readOnly, true);

	handler("", ctx);
	check("status after on mentions ACTIVE", notifications[2].message.includes("ACTIVE"), true);

	handler("off", ctx);
	check("off notifies once", notifications.length, 4);
	check("off effect via loadProjectConfig", loadProjectConfig(commandProject).readOnly, false);

	handler("bogus", ctx);
	check("unknown arg notifies once", notifications.length, 5);
	check("unknown arg shows usage", notifications[4].message.includes("Usage:"), true);
	check("unknown arg notification is an error", notifications[4].type, "error");
}
rmSync(commandProject, { recursive: true, force: true });

rmSync(noFile, { recursive: true, force: true });

if (checkFailures() > 0) {
	console.error(`\n${checkFailures()} read-only command test(s) failed.`);
	process.exit(1);
} else {
	console.log("\nAll read-only command tests passed.");
}
