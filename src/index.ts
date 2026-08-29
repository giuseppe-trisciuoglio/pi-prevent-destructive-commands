import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { relative } from "node:path";
import { checkTokens } from "./checker";
import { ENABLE_GIT_ADD_COMMIT_BLOCK } from "./config";
import {
	DRIZZLE_MIGRATION_BLOCK_REASON,
	findDrizzleMigrationDirectories,
	isDrizzleMigrationPath,
	isPotentialMigrationMutation,
} from "./migration-guard";
import { findNxConfigurationMutation, NX_CONFIG_BLOCK_REASON } from "./nx-guard";
import {
	CONFIG_MUTATING_COMMAND,
	DEFAULT_PROJECT_CONFIG,
	PROJECT_CONFIG_BLOCK_REASON,
	PROJECT_CONFIG_RELATIVE_PATH,
	commandReferencesProjectConfig,
	loadProjectConfig,
} from "./project-config";
import { tokenize } from "./tokenizer";
import { registerGitGuardsCommand } from "./git-guards-command";

function pathsFromPatch(patch: string): string[] {
	const paths: string[] = [];
	const diffPath = /^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\n]+)$/gm;
	const applyPatchPath = /^\*\*\* (?:Add|Delete|Update|Move to) File: (.+)$/gm;

	for (const expression of [diffPath, applyPatchPath]) {
		let match: RegExpExecArray | null;
		while ((match = expression.exec(patch)) !== null) {
			if (match[1] !== "/dev/null") paths.push(match[1]);
		}
	}

	return paths;
}

function pathsWrittenByTool(toolName: string, input: Record<string, unknown>): string[] {
	if (toolName === "write" || toolName === "edit") {
		return typeof input.path === "string" ? [input.path] : [];
	}

	if (toolName.endsWith("apply_patch")) {
		return [input.input, input.patch]
			.filter((value): value is string => typeof value === "string")
			.flatMap(pathsFromPatch);
	}

	if (toolName.endsWith("rename_refactoring")) {
		return typeof input.pathInProject === "string" ? [input.pathInProject] : [];
	}

	return [];
}

function commandReferencesMigrationPath(command: string, cwd: string, migrationDirectories: readonly string[]): boolean {
	const normalizedCommand = command.replaceAll("\\", "/");
	return migrationDirectories.some((directory) => {
		const relativeDirectory = relative(cwd, directory).replaceAll("\\", "/");
		const absoluteDirectory = directory.replaceAll("\\", "/");
		return (
			normalizedCommand.includes(absoluteDirectory) ||
			normalizedCommand.includes(relativeDirectory) ||
			normalizedCommand.includes(`./${relativeDirectory}`)
		);
	}) || tokenize(command).some((token) =>
		!token.startsWith("-") && isDrizzleMigrationPath(token, cwd, migrationDirectories),
	);
}

export default function (pi: ExtensionAPI) {
	registerGitGuardsCommand(pi);

	pi.on("tool_call", async (event, ctx) => {
		// The per-project opt-out file is user-only: the agent must never create
		// or edit it, neither through the writing tools nor through bash.
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			if (
				typeof command === "string" &&
				CONFIG_MUTATING_COMMAND.test(command) &&
				commandReferencesProjectConfig(command)
			) {
				return { block: true, reason: PROJECT_CONFIG_BLOCK_REASON };
			}
		} else {
			const input = event.input as Record<string, unknown>;
			const touchedConfig = pathsWrittenByTool(event.toolName, input).some(
				(path) => path.replaceAll("\\", "/").replace(/^\.\//, "") === PROJECT_CONFIG_RELATIVE_PATH,
			);
			if (touchedConfig) {
				return { block: true, reason: PROJECT_CONFIG_BLOCK_REASON };
			}
		}

		const nxConfigurationPath = await findNxConfigurationMutation(
			event.toolName,
			event.input as Record<string, unknown>,
			ctx.cwd,
		);
		if (nxConfigurationPath) {
			return { block: true, reason: NX_CONFIG_BLOCK_REASON };
		}

		const migrationDirectories = await findDrizzleMigrationDirectories(ctx.cwd);

		if (migrationDirectories.length > 0) {
			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;
				if (
					typeof command === "string" &&
					isPotentialMigrationMutation(command) &&
					commandReferencesMigrationPath(command, ctx.cwd, migrationDirectories)
				) {
					return { block: true, reason: DRIZZLE_MIGRATION_BLOCK_REASON };
				}
			} else {
				const input = event.input as Record<string, unknown>;
				const protectedPath = pathsWrittenByTool(event.toolName, input).find((path) =>
					isDrizzleMigrationPath(path, ctx.cwd, migrationDirectories),
				);
				if (protectedPath) {
					return { block: true, reason: DRIZZLE_MIGRATION_BLOCK_REASON };
				}
			}
		}

		if (!isToolCallEventType("bash", event)) return undefined;

		const command = event.input.command;
		if (typeof command !== "string" || command.length === 0) return undefined;

		const projectConfig = ctx.cwd
			? loadProjectConfig(ctx.cwd)
			: DEFAULT_PROJECT_CONFIG;
		const gitGuardsEnabled =
			ENABLE_GIT_ADD_COMMIT_BLOCK && !projectConfig.disableGitGuards;

		const { dangerous, reason } = checkTokens(tokenize(command), ctx.cwd, 0, false, ctx.cwd, {
			gitGuardsEnabled,
		});
		if (!dangerous) return undefined;

		return {
			block: true,
			reason: `[prevent-destructive-commands] Blocked: ${reason}`,
		};
	});
}
