/**
 * `/git-guards` slash command: inspect and toggle the per-project git guard
 * opt-out straight from the pi TUI.
 *
 * The opt-out file is normally user-managed: the extension blocks the agent
 * from writing it via tool calls. This command is exempt by design — it runs
 * in the extension process only when the user invokes it explicitly, so it is
 * the same as the user editing the file by hand.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ENABLE_GIT_ADD_COMMIT_BLOCK } from "./config";
import {
	loadProjectConfig,
	projectConfigPath,
	PROJECT_CONFIG_RELATIVE_PATH,
	resetProjectConfigCache,
} from "./project-config";

export type GitGuardsAction = "status" | "off" | "on" | "usage";

/** Parses the raw command arguments; unknown input maps to "usage". */
export function parseGitGuardsArgs(args: string): GitGuardsAction {
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

export interface GitGuardsStatus {
	/** Whether the git add/commit/push guards are currently active. */
	guardsEnabled: boolean;
	fileExists: boolean;
	fileValid: boolean;
	/** True when guards are off because of the global flag, not the project file. */
	disabledGlobally: boolean;
}

export function gitGuardsStatus(cwd: string): GitGuardsStatus {
	const path = projectConfigPath(cwd);

	let fileExists = false;
	try {
		statSync(path);
		fileExists = true;
	} catch {
		// No file: guards active by default.
	}

	let fileValid = !fileExists; // A missing file is not an invalid file.
	if (fileExists) {
		try {
			const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
			fileValid = typeof raw === "object" && raw !== null && !Array.isArray(raw);
		} catch {
			fileValid = false;
		}
	}

	const disabledByFile = loadProjectConfig(cwd).disableGitGuards;

	return {
		guardsEnabled: ENABLE_GIT_ADD_COMMIT_BLOCK && !disabledByFile,
		fileExists,
		fileValid,
		disabledGlobally: !ENABLE_GIT_ADD_COMMIT_BLOCK,
	};
}

/**
 * Writes `disableGitGuards` into the opt-out file, preserving unrelated JSON
 * keys. Creates the `.pi` directory when missing. Returns whether the previous
 * file content was invalid (and therefore replaced).
 */
export function applyGitGuards(cwd: string, disable: boolean): boolean {
	const path = projectConfigPath(cwd);

	let previous: Record<string, unknown> = {};
	let replacedInvalid = false;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
			previous = raw as Record<string, unknown>;
		} else {
			replacedInvalid = true;
		}
	} catch {
		// Missing file or unparseable content: start from a clean object.
		try {
			statSync(path);
			replacedInvalid = true;
		} catch {
			// File simply absent: nothing lost.
		}
	}

	previous.disableGitGuards = disable;

	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(previous, null, "\t")}\n`, "utf8");
	resetProjectConfigCache();

	return replacedInvalid;
}

function statusMessage(cwd: string): { text: string; level: "info" | "warning" | "error" } {
	const status = gitGuardsStatus(cwd);

	const lines: string[] = [];
	if (status.disabledGlobally) {
		lines.push(
			`git guards are DISABLED globally (ENABLE_GIT_ADD_COMMIT_BLOCK = false in src/config.ts); the project file cannot re-enable them.`,
		);
	} else if (status.guardsEnabled) {
		lines.push("git guards are ACTIVE for this project (git add / commit / push blocked).");
	} else {
		lines.push(
			"git guards are DISABLED for this project (git add / commit / push allowed; force/delete push variants remain blocked).",
		);
	}

	if (!status.fileExists) {
		lines.push(`opt-out file: none (${PROJECT_CONFIG_RELATIVE_PATH} missing — safe default)`);
	} else if (!status.fileValid) {
		lines.push(`opt-out file: ${PROJECT_CONFIG_RELATIVE_PATH} exists but is not valid JSON — ignored, guards stay active`);
	} else {
		lines.push(`opt-out file: ${PROJECT_CONFIG_RELATIVE_PATH}`);
	}

	const level = !status.fileExists || status.fileValid || !status.guardsEnabled ? "info" : "warning";
	return { text: lines.join("\n"), level };
}

export const GIT_GUARDS_USAGE = `Usage: /git-guards [on|off|status]
  (no args)  show whether the git add/commit/push guards are active for this project
  off        write {"disableGitGuards": true} to ${PROJECT_CONFIG_RELATIVE_PATH}
  on         write {"disableGitGuards": false} to ${PROJECT_CONFIG_RELATIVE_PATH}`;

/** Registers the `/git-guards` command on the pi runtime. */
export function registerGitGuardsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("git-guards", {
		description: "Show or toggle the per-project git add/commit/push guards (/git-guards [on|off])",
		handler: async (args: string, ctx: { cwd: string; ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } }) => {
			switch (parseGitGuardsArgs(args)) {
				case "status": {
					const { text, level } = statusMessage(ctx.cwd);
					ctx.ui.notify(text, level);
					return;
				}
				case "off": {
					const replacedInvalid = applyGitGuards(ctx.cwd, true);
					ctx.ui.notify(
						`git guards DISABLED for this project (git add / commit / push allowed; force/delete push variants remain blocked).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"warning",
					);
					return;
				}
				case "on": {
					const replacedInvalid = applyGitGuards(ctx.cwd, false);
					ctx.ui.notify(
						`git guards ENABLED for this project (git add / commit / push blocked).${replacedInvalid ? ` Note: previous ${PROJECT_CONFIG_RELATIVE_PATH} was invalid JSON and was replaced.` : ""}`,
						"info",
					);
					return;
				}
				case "usage":
					ctx.ui.notify(GIT_GUARDS_USAGE, "error");
					return;
			}
		},
	});
}
