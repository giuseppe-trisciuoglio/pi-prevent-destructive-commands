import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";

const DRIZZLE_CONFIG_FILE = /^drizzle\.config\.(?:[cm]?[jt]s)$/;
const DEFAULT_MIGRATIONS_DIRECTORY = "drizzle";
const MUTATING_COMMAND = /(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|touch|mkdir|install|tee|truncate|dd|chmod|chown|chgrp|ln|patch|apply_patch)\b|\b(?:sed|perl)\s+(?:\S+\s+)*-i\b|\b(?:git\s+apply|find\s+.+\s-delete)\b|(?:^|\s)>{1,2}|\b2>{1,2}\b/;

function isWithin(path: string, directory: string): boolean {
	const relativePath = relative(directory, path);
	return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function resolveMigrationDirectory(configDirectory: string, configuredPath: string): string {
	return normalize(isAbsolute(configuredPath) ? configuredPath : resolve(configDirectory, configuredPath));
}

function migrationDirectoriesFromConfig(configDirectory: string, source: string): string[] {
	const directories = new Set<string>();
	const outPattern = /\bout\s*:\s*(["'`])([^"'`$]+)\1/g;
	let match: RegExpExecArray | null;

	while ((match = outPattern.exec(source)) !== null) {
		directories.add(resolveMigrationDirectory(configDirectory, match[2]));
	}

	if (directories.size === 0) {
		directories.add(resolveMigrationDirectory(configDirectory, DEFAULT_MIGRATIONS_DIRECTORY));
	}

	return [...directories];
}

/** Finds migration output directories declared by Drizzle configuration files above cwd. */
export async function findDrizzleMigrationDirectories(cwd: string): Promise<string[]> {
	const directories = new Set<string>();
	let directory = resolve(cwd);

	while (true) {
		let entries: string[] = [];
		try {
			entries = await readdir(directory);
		} catch {
			// An unreadable ancestor cannot provide a configuration for this guard.
		}

		for (const entry of entries) {
			if (!DRIZZLE_CONFIG_FILE.test(entry)) continue;
			try {
				const source = await readFile(resolve(directory, entry), "utf8");
				for (const migrationDirectory of migrationDirectoriesFromConfig(directory, source)) {
					directories.add(migrationDirectory);
				}
			} catch {
				// Ignore a configuration that disappears while the tool call is checked.
			}
		}

		const parent = dirname(directory);
		if (parent === directory) break;
		directory = parent;
	}

	return [...directories];
}

export function isDrizzleMigrationPath(path: string, cwd: string, migrationDirectories: readonly string[]): boolean {
	const target = normalize(isAbsolute(path) ? path : resolve(cwd, path));
	return migrationDirectories.some((directory) => isWithin(target, directory));
}

export function isPotentialMigrationMutation(command: string): boolean {
	return MUTATING_COMMAND.test(command);
}

export const DRIZZLE_MIGRATION_BLOCK_REASON =
	"Le migration di Drizzle non possono essere modificate direttamente: usa un comando Drizzle per generarle o aggiornarle.";
