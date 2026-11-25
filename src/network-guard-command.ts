import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	loadProjectConfig,
	PROJECT_CONFIG_RELATIVE_PATH,
	projectConfigFileStatus,
	writeProjectConfigFlag,
} from "./project-config";

export type NetworkGuardAction = "status" | "off" | "on" | "usage";

export function parseNetworkGuardArgs(args: string): NetworkGuardAction {
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

export interface NetworkGuardStatus {
	guardEnabled: boolean;
	fileExists: boolean;
	fileValid: boolean;
}

export function networkGuardStatus(cwd: string): NetworkGuardStatus {
	const { fileExists, fileValid } = projectConfigFileStatus(cwd);
	const disabledByFile = loadProjectConfig(cwd).disableNetworkGuard;

	return {
		guardEnabled: !disabledByFile,
		fileExists,
		fileValid,
	};
}

export function applyNetworkGuard(cwd: string, disable: boolean): boolean {
	return writeProjectConfigFlag(cwd, (config) => {
		config.disableNetworkGuard = disable;
	});
}

function statusMessage(cwd: string): { text: string; level: "info" | "warning" | "error" } {
	const status = networkGuardStatus(cwd);

	const lines: string[] = [];
	if (status.guardEnabled) {
		lines.push("network guard is ACTIVE for this project: curl/wget requests to hosts other than localhost are blocked.");
	} else {
		lines.push("network guard is INACTIVE for this project: curl/wget requests to external hosts are allowed.");
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

export const NETWORK_GUARD_USAGE = `Usage: /network-guard [on|off|status]
  (no args)  show whether the network guard is active for this project
  off        write {"disableNetworkGuard": true} to ${PROJECT_CONFIG_RELATIVE_PATH}
  on         write {"disableNetworkGuard": false} to ${PROJECT_CONFIG_RELATIVE_PATH}`;

export function registerNetworkGuardCommand(pi: ExtensionAPI): void {
	pi.registerCommand("network-guard", {
		description: "Show or toggle the per-project network guard for curl/wget (/network-guard [on|off])",
		handler: async (args: string, ctx: { cwd: string; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }) => {
			switch (parseNetworkGuardArgs(args)) {
				case "status": {
					const { text, level } = statusMessage(ctx.cwd);
					ctx.ui.notify(text, level);
					return;
				}
				case "off": {
					const replacedInvalid = applyNetworkGuard(ctx.cwd, true);
					ctx.ui.notify(
						`network guard DISABLED for this project (curl/wget requests to external hosts are allowed).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"warning",
					);
					return;
				}
				case "on": {
					const replacedInvalid = applyNetworkGuard(ctx.cwd, false);
					ctx.ui.notify(
						`network guard ENABLED for this project (curl/wget requests to hosts other than localhost are blocked).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"info",
					);
					return;
				}
				case "usage":
					ctx.ui.notify(NETWORK_GUARD_USAGE, "error");
					return;
			}
		},
	});
}
