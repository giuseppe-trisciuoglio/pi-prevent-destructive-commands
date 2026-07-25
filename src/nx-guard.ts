import { lstat } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { tokenize } from "./tokenizer";

const NX_WORKSPACE_FILE = "nx.json";
const PROTECTED_FILE_NAMES: ReadonlySet<string> = new Set([
	"package.json",
	"tsconfig.json",
	"tsconfig.base.json",
	"tsconfig.lib.json",
	"tsconfig.spec.json",
]);
const COMMAND_SEPARATORS: ReadonlySet<string> = new Set(["|", ";", "&&", "||", "&", "(", ")"]);
const REDIRECT_OPERATORS: ReadonlySet<string> = new Set([">", ">>", "2>", "2>>", "&>", "&>>"]);
const ALL_PATH_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
	"rm",
	"rmdir",
	"unlink",
	"shred",
	"touch",
	"truncate",
	"tee",
	"chmod",
	"chown",
	"chgrp",
	"sed",
	"perl",
]);
const DESTINATION_ONLY_COMMANDS: ReadonlySet<string> = new Set(["cp", "install", "ln"]);
const FORMATTER_COMMANDS: ReadonlySet<string> = new Set(["prettier", "biome", "eslint"]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MUTATION_COMMANDS: ReadonlySet<string> = new Set([
	"add",
	"install",
	"uninstall",
	"remove",
	"update",
	"upgrade",
]);

export const NX_CONFIG_BLOCK_REASON =
	"Nei workspace Nx i file package.json e tsconfig esistenti sono protetti: puoi crearne uno nuovo, ma non modificare o eliminare quelli già presenti.";

function isWithin(path: string, directory: string): boolean {
	const relativePath = relative(directory, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolvePath(path: string, cwd: string): string {
	return normalize(isAbsolute(path) ? path : resolve(cwd, path));
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

export async function findNxWorkspaceRoot(cwd: string): Promise<string | undefined> {
	let directory = resolve(cwd);

	while (true) {
		if (await exists(resolve(directory, NX_WORKSPACE_FILE))) return directory;

		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function isNxConfigurationPath(path: string, cwd: string, workspaceRoot: string): boolean {
	const target = resolvePath(path, cwd);
	return isWithin(target, workspaceRoot) && PROTECTED_FILE_NAMES.has(basename(target));
}

async function firstExistingNxConfigurationPath(
	paths: readonly string[],
	cwd: string,
	workspaceRoot: string,
): Promise<string | undefined> {
	for (const path of paths) {
		if (!isNxConfigurationPath(path, cwd, workspaceRoot)) continue;
		if (await exists(resolvePath(path, cwd))) return path;
	}

	return undefined;
}

function patchPaths(patch: string): string[] {
	const paths: string[] = [];
	const applyPatchPath = /^\*\*\* (?:Add|Delete|Update) File: (.+)$/gm;
	const movePath = /^\*\*\* Move to: (.+)$/gm;
	const diffPath = /^(?:---|\+\+\+)\s+(?:[ab]\/)?([^\t\n]+)$/gm;

	for (const expression of [applyPatchPath, movePath, diffPath]) {
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
			.flatMap(patchPaths);
	}

	if (toolName.endsWith("rename_refactoring")) {
		return typeof input.pathInProject === "string" ? [input.pathInProject] : [];
	}

	if (toolName.endsWith("apply_quick_fix")) {
		return typeof input.filePath === "string" ? [input.filePath] : [];
	}

	return [];
}

function splitCommand(tokens: readonly string[]): string[][] {
	const segments: string[][] = [];
	let segment: string[] = [];

	for (const token of tokens) {
		if (COMMAND_SEPARATORS.has(token)) {
			if (segment.length > 0) segments.push(segment);
			segment = [];
			continue;
		}
		segment.push(token);
	}

	if (segment.length > 0) segments.push(segment);
	return segments;
}

function positionalArguments(tokens: readonly string[], start: number): string[] {
	const args: string[] = [];
	let optionsEnded = false;

	for (let i = start; i < tokens.length; i++) {
		const token = tokens[i];
		if (REDIRECT_OPERATORS.has(token)) {
			i++;
			continue;
		}
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-")) continue;
		args.push(token);
	}

	return args;
}

function hasWriteFlag(tokens: readonly string[]): boolean {
	return tokens.some((token) => token === "--write" || token === "--fix" || token === "-w");
}

function mutationPathsFromSegment(segment: readonly string[]): string[] {
	const paths: string[] = [];

	for (let i = 0; i < segment.length; i++) {
		if (REDIRECT_OPERATORS.has(segment[i]) && segment[i + 1]) {
			paths.push(segment[i + 1]);
		}
	}

	for (let i = 0; i < segment.length; i++) {
		const command = segment[i];
		const args = positionalArguments(segment, i + 1);

		if (command === "mv" || ALL_PATH_MUTATING_COMMANDS.has(command)) {
			paths.push(...args);
			continue;
		}

		if (DESTINATION_ONLY_COMMANDS.has(command)) {
			const destination = args.at(-1);
			if (destination) paths.push(destination);
			continue;
		}

		if (command === "dd") {
			for (const arg of args) {
				if (arg.startsWith("of=")) paths.push(arg.slice(3));
			}
			continue;
		}

		if (command === "git" && segment[i + 1] === "apply") {
			paths.push(...args);
			continue;
		}

		if (FORMATTER_COMMANDS.has(command) && hasWriteFlag(segment.slice(i + 1))) {
			paths.push(...args);
			continue;
		}

		if (["bash", "sh", "zsh", "fish", "dash", "ksh"].includes(command)) {
			const commandIndex = segment.indexOf("-c", i + 1);
			if (commandIndex !== -1 && segment[commandIndex + 1]) {
				paths.push(...mutationPathsFromBashCommand(segment[commandIndex + 1]));
			}
		}
	}

	return paths;
}

function mutationPathsFromBashCommand(command: string): string[] {
	return splitCommand(tokenize(command)).flatMap(mutationPathsFromSegment);
}

function mutatesPackageManifest(command: string): boolean {
	for (const segment of splitCommand(tokenize(command))) {
		for (let i = 0; i < segment.length; i++) {
			if (!PACKAGE_MANAGERS.has(segment[i])) continue;

			for (let j = i + 1; j < segment.length; j++) {
				if (PACKAGE_MUTATION_COMMANDS.has(segment[j])) return true;
				if (segment[j] === "pkg" && ["set", "delete"].includes(segment[j + 1] ?? "")) return true;
			}
		}
	}

	return false;
}

async function nearestExistingPackageJson(cwd: string, workspaceRoot: string): Promise<string | undefined> {
	let directory = resolve(cwd);

	while (isWithin(directory, workspaceRoot)) {
		const candidate = resolve(directory, "package.json");
		if (await exists(candidate)) return candidate;
		if (directory === workspaceRoot) break;
		directory = dirname(directory);
	}

	return undefined;
}

export function isPotentialNxConfigurationMutation(command: string): boolean {
	return mutationPathsFromBashCommand(command).length > 0 || mutatesPackageManifest(command);
}

export async function findNxConfigurationMutation(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): Promise<string | undefined> {
	const workspaceRoot = await findNxWorkspaceRoot(cwd);
	if (!workspaceRoot) return undefined;

	if (toolName === "bash") {
		const command = input.command;
		if (typeof command !== "string") return undefined;

		const directMutation = await firstExistingNxConfigurationPath(
			mutationPathsFromBashCommand(command),
			cwd,
			workspaceRoot,
		);
		if (directMutation) return directMutation;

		if (mutatesPackageManifest(command)) {
			return nearestExistingPackageJson(cwd, workspaceRoot);
		}

		return undefined;
	}

	return firstExistingNxConfigurationPath(pathsWrittenByTool(toolName, input), cwd, workspaceRoot);
}
