import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadProjectConfig,
	PROJECT_CONFIG_RELATIVE_PATH,
	projectConfigFileStatus,
	writeProjectConfigFlag,
} from "./project-config";

export type WorkdirGuardAction = "status" | "off" | "on" | "usage";

export function parseWorkdirGuardArgs(args: string): WorkdirGuardAction {
	switch (args.trim().toLowerCase()) {
		case "":
		case "status":
			return "status";
		case "off":
		case "disable":
			return "off";
		case "on":
		case "enable":
			return "on";
		default:
			return "usage";
	}
}

export interface WorkdirGuardStatus {
	guardEnabled: boolean;
	fileExists: boolean;
	fileValid: boolean;
}

export function workdirGuardStatus(cwd: string): WorkdirGuardStatus {
	const { fileExists, fileValid } = projectConfigFileStatus(cwd);
	const disabledByFile = loadProjectConfig(cwd).disableWorkdirGuard;

	return {
		guardEnabled: !disabledByFile,
		fileExists,
		fileValid,
	};
}

export function applyWorkdirGuard(cwd: string, disable: boolean): boolean {
	return writeProjectConfigFlag(cwd, (config) => {
		config.disableWorkdirGuard = disable;
	});
}

function statusMessage(cwd: string): { text: string; level: "info" | "warning" | "error" } {
	const status = workdirGuardStatus(cwd);

	const lines: string[] = [];
	if (status.guardEnabled) {
		lines.push("workdir guard is ACTIVE for this project: file operations outside the working directory are blocked.");
	} else {
		lines.push("workdir guard is INACTIVE for this project: file operations outside the working directory are allowed.");
	}

	if (!status.fileExists) {
		lines.push(`configuration file: none (${PROJECT_CONFIG_RELATIVE_PATH} missing — safe default: guard active)`);
	} else if (!status.fileValid) {
		lines.push(`configuration file: ${PROJECT_CONFIG_RELATIVE_PATH} exists but is not valid JSON — ignored, guard active`);
	} else {
		lines.push(`configuration file: ${PROJECT_CONFIG_RELATIVE_PATH}`);
	}

	const level = status.guardEnabled ? "info" : "warning";
	return { text: lines.join("\n"), level };
}

export const WORKDIR_GUARD_USAGE = `Usage: /workdir-guard [on|off|status]
  (no args)  show whether the workdir guard is active for this project
  off        write {"disableWorkdirGuard": true} to ${PROJECT_CONFIG_RELATIVE_PATH}
  on         write {"disableWorkdirGuard": false} to ${PROJECT_CONFIG_RELATIVE_PATH}`;

export function registerWorkdirGuardCommand(pi: ExtensionAPI): void {
	pi.registerCommand("workdir-guard", {
		description: "Show or toggle the per-project workdir boundary guard (/workdir-guard [on|off])",
		handler: async (args: string, ctx: { cwd: string; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }) => {
			switch (parseWorkdirGuardArgs(args)) {
				case "status": {
					const { text, level } = statusMessage(ctx.cwd);
					ctx.ui.notify(text, level);
					return;
				}
				case "off": {
					const replacedInvalid = applyWorkdirGuard(ctx.cwd, true);
					ctx.ui.notify(
						`workdir guard DISABLED for this project (file operations outside the working directory are allowed).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"warning",
					);
					return;
				}
				case "on": {
					const replacedInvalid = applyWorkdirGuard(ctx.cwd, false);
					ctx.ui.notify(
						`workdir guard ENABLED for this project (file operations outside the working directory are blocked).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"info",
					);
					return;
				}
				case "usage":
					ctx.ui.notify(WORKDIR_GUARD_USAGE, "error");
					return;
			}
		},
	});
}
