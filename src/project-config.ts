/**
 * Per-project configuration for the extension.
 *
 * The configuration lives exclusively in `.pi/prevent-destructive-commands.json`
 * inside the project working directory. There is deliberately no global
 * fallback: when the file is missing or invalid, every guard stays active
 * (safe default). The file is meant to be created and edited manually by the
 * user — the extension itself blocks the agent from writing to it.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_CONFIG_RELATIVE_PATH = ".pi/prevent-destructive-commands.json";

export interface ProjectConfig {
	/** When true, the `git add` / `git commit` / `git push` guards are disabled. */
	disableGitGuards: boolean;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = { disableGitGuards: false };

/** Absolute path of the project configuration file for a given cwd. */
export function projectConfigPath(cwd: string): string {
	return join(cwd, ...PROJECT_CONFIG_RELATIVE_PATH.split("/"));
}

interface CacheEntry {
	mtimeMs: number;
	config: ProjectConfig;
}

const cache = new Map<string, CacheEntry>();

/**
 * Loads the project configuration, caching by file mtime so every tool call
 * picks up manual edits without re-reading unchanged files. A missing or
 * unparseable file yields the safe defaults (all guards active).
 */
export function loadProjectConfig(cwd: string): ProjectConfig {
	const path = projectConfigPath(cwd);

	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		cache.delete(cwd);
		return DEFAULT_PROJECT_CONFIG;
	}

	const cached = cache.get(cwd);
	if (cached && cached.mtimeMs === mtimeMs) return cached.config;

	let config = DEFAULT_PROJECT_CONFIG;
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof raw === "object" && raw !== null) {
			config = {
				disableGitGuards:
					(raw as Record<string, unknown>).disableGitGuards === true,
			};
		}
	} catch {
		// Invalid JSON: keep the guards active rather than trusting the file.
	}

	cache.set(cwd, { mtimeMs, config });
	return config;
}

export const PROJECT_CONFIG_BLOCK_REASON =
	`[prevent-destructive-commands] Blocked: ${PROJECT_CONFIG_RELATIVE_PATH} is the per-project opt-out file of this extension and must be created or edited manually by the user, never by the agent.`;

/** Matches shell commands that could create or modify the project config file. */
export const CONFIG_MUTATING_COMMAND =
	/(?:^|[;&|]\s*)(?:rm|rmdir|mv|cp|touch|mkdir|install|tee|truncate|dd|chmod|chown|chgrp|ln|patch|apply_patch)\b|\b(?:sed|perl)\s+(?:\S+\s+)*-i\b|\b(?:git\s+apply)\b|(?:^|\s)>{1,2}|\b2>{1,2}/;

export function commandReferencesProjectConfig(command: string): boolean {
	const normalized = command.replaceAll("\\", "/");
	return (
		normalized.includes(PROJECT_CONFIG_RELATIVE_PATH) ||
		normalized.includes(`./${PROJECT_CONFIG_RELATIVE_PATH}`)
	);
}

/** Test hook: drops the mtime cache. */
export function resetProjectConfigCache(): void {
	cache.clear();
}
