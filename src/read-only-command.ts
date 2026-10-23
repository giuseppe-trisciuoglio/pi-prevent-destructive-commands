import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadProjectConfig,
	PROJECT_CONFIG_RELATIVE_PATH,
	projectConfigFileStatus,
	writeProjectConfigFlag,
} from "./project-config";

export type ReadOnlyAction = "status" | "off" | "on" | "usage";

export function parseReadOnlyArgs(args: string): ReadOnlyAction {
	switch (args.trim().toLowerCase()) {
		case "":
		case "status":
			return "status";
		case "off":
			return "off";
		case "on":
			return "on";
		default:
			return "usage";
	}
}

export interface ReadOnlyStatus {
	readOnly: boolean;
	fileExists: boolean;
	fileValid: boolean;
}

export function readOnlyStatus(cwd: string): ReadOnlyStatus {
	const { fileExists, fileValid } = projectConfigFileStatus(cwd);
	return {
		readOnly: loadProjectConfig(cwd).readOnly,
		fileExists,
		fileValid,
	};
}

export function applyReadOnly(cwd: string, value: boolean): boolean {
	return writeProjectConfigFlag(cwd, (config) => {
		config.readOnly = value;
	});
}

function statusMessage(cwd: string): { text: string; level: "info" | "warning" | "error" } {
	const status = readOnlyStatus(cwd);

	const lines: string[] = [];
	if (status.readOnly) {
		lines.push("read-only mode is ACTIVE for this project: write, edit, patch, bash, and powershell are blocked.");
	} else {
		lines.push("read-only mode is INACTIVE for this project: mutating tools are allowed.");
	}

	if (!status.fileExists) {
		lines.push(`configuration file: none (${PROJECT_CONFIG_RELATIVE_PATH} missing — safe default: read-only off)`);
	} else if (!status.fileValid) {
		lines.push(`configuration file: ${PROJECT_CONFIG_RELATIVE_PATH} exists but is not valid JSON — ignored, read-only off`);
	} else {
		lines.push(`configuration file: ${PROJECT_CONFIG_RELATIVE_PATH}`);
	}

	const level = status.readOnly ? "warning" : "info";
	return { text: lines.join("\n"), level };
}

export const READ_ONLY_USAGE = `Usage: /read-only [on|off|status]
  (no args)  show whether read-only mode is active for this project
  on         write {"readOnly": true} to ${PROJECT_CONFIG_RELATIVE_PATH}
  off        write {"readOnly": false} to ${PROJECT_CONFIG_RELATIVE_PATH}`;

export const READ_ONLY_BLOCK_REASON =
	"[prevent-destructive-commands] Blocked: read-only mode is enabled for this project (use /read-only off to allow modifications).";

export function isReadOnlyMutatingTool(toolName: string): boolean {
	return (
		toolName === "write" ||
		toolName === "edit" ||
		toolName === "bash" ||
		toolName === "powershell" ||
		toolName.endsWith("apply_patch")
	);
}

export interface ReadOnlyBlockResult {
	block: true;
	reason: string;
}

export function readOnlyBlockResult(
	toolName: string,
	config: { readOnly: boolean },
): ReadOnlyBlockResult | undefined {
	if (!config.readOnly || !isReadOnlyMutatingTool(toolName)) return undefined;
	return { block: true, reason: READ_ONLY_BLOCK_REASON };
}

export function registerReadOnlyCommand(pi: ExtensionAPI): void {
	pi.registerCommand("read-only", {
		description: "Show or toggle per-project read-only mode (/read-only [on|off])",
		handler: async (args: string, ctx: { cwd: string; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }) => {
			switch (parseReadOnlyArgs(args)) {
				case "status": {
					const { text, level } = statusMessage(ctx.cwd);
					ctx.ui.notify(text, level);
					return;
				}
				case "on": {
					const replacedInvalid = applyReadOnly(ctx.cwd, true);
					ctx.ui.notify(
						`read-only mode ENABLED for this project (write, edit, patch, bash, and powershell are blocked).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"warning",
					);
					return;
				}
				case "off": {
					const replacedInvalid = applyReadOnly(ctx.cwd, false);
					ctx.ui.notify(
						`read-only mode DISABLED for this project (mutating tools allowed again).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"info",
					);
					return;
				}
				case "usage":
					ctx.ui.notify(READ_ONLY_USAGE, "error");
					return;
			}
		},
	});
}
