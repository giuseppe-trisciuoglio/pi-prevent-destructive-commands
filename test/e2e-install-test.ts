/**
 * End-to-end installation test.
 *
 * Unlike test/smoke-test.ts (which imports tokenizer/checker directly),
 * this test drives the real @earendil-works/pi-coding-agent package to
 * verify the extension actually installs and loads the way pi does it:
 *
 *   1. The package.json "pi" manifest declares a resolvable entry point.
 *   2. Manual installation (cloning into <agentDir>/extensions/<name>, as
 *      documented in README.md) is discovered and loaded by pi's own
 *      discoverAndLoadExtensions().
 *   3. `pi install <path>` (the CLI command documented in README.md)
 *      records the package and pi can subsequently discover/load it.
 *   4. Once loaded through that real pipeline, the registered "tool_call"
 *      handler still blocks/allows commands correctly.
 *
 * Run with:
 *   npx tsx test/e2e-install-test.ts
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

// Loaded via dynamic import (not a static import) because this ESM-only
// package's "exports" map has no "require" condition, which trips up tsx's
// CJS-style resolver when used in a static import statement.
async function loadDiscoverAndLoadExtensions() {
	const mod = await import("@earendil-works/pi-coding-agent");
	return mod.discoverAndLoadExtensions;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXTENSION_NAME = "prevent-destructive-commands";
function resolvePiCliPath(): string {
	const packageRoot = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
	const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf-8"));
	const binPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (!binPath) throw new Error("Could not resolve pi CLI bin path from @earendil-works/pi-coding-agent package.json");
	return path.join(packageRoot, binPath);
}

const PI_CLI = resolvePiCliPath();

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: string): void {
	const status = ok ? "PASS" : "FAIL";
	if (ok) passed++;
	else failed++;
	console.log(`${status}  ${label}${!ok && detail ? `  -> ${detail}` : ""}`);
}

function mkTempDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Copies just the files an installed pi package needs (manifest + source). */
function copyPackageInto(destDir: string): void {
	fs.mkdirSync(destDir, { recursive: true });
	fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(destDir, "package.json"));
	fs.cpSync(path.join(REPO_ROOT, "src"), path.join(destDir, "src"), { recursive: true });
}

async function runFunctionalChecks(handler: (...args: unknown[]) => Promise<unknown>, label: string): Promise<void> {
	const ctx = { cwd: "/home/user/projects/demo" } as unknown as ExtensionContext;

	const dangerous = (await handler(
		{ type: "tool_call", toolCallId: "1", toolName: "bash", input: { command: "git reset --hard" } },
		ctx,
	)) as ToolCallEventResult | undefined;
	check(`${label}: blocks "git reset --hard"`, dangerous?.block === true, JSON.stringify(dangerous));

	const outsideRm = (await handler(
		{ type: "tool_call", toolCallId: "2", toolName: "bash", input: { command: "rm -rf /etc" } },
		ctx,
	)) as ToolCallEventResult | undefined;
	check(`${label}: blocks "rm -rf /etc"`, outsideRm?.block === true, JSON.stringify(outsideRm));

	const safe = (await handler(
		{ type: "tool_call", toolCallId: "3", toolName: "bash", input: { command: "ls -la" } },
		ctx,
	)) as ToolCallEventResult | undefined;
	check(`${label}: allows "ls -la"`, safe === undefined, JSON.stringify(safe));
}

async function testManifestDeclaresResolvableEntry(): Promise<void> {
	const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8"));
	const entries: string[] = pkg?.pi?.extensions ?? [];
	check("package.json declares pi.extensions", entries.length > 0, JSON.stringify(pkg.pi));

	for (const entry of entries) {
		const resolved = path.resolve(REPO_ROOT, entry);
		check(`declared entry point exists on disk: ${entry}`, fs.existsSync(resolved));
	}
}

async function testManualInstallationIsDiscovered(
	discoverAndLoadExtensions: Awaited<ReturnType<typeof loadDiscoverAndLoadExtensions>>,
): Promise<void> {
	// Mirrors README.md "Manual Installation": clone into <agentDir>/extensions/<name>.
	const agentDir = mkTempDir("pi-e2e-agentdir-");
	try {
		copyPackageInto(path.join(agentDir, "extensions", EXTENSION_NAME));

		const result = await discoverAndLoadExtensions([], REPO_ROOT, agentDir);

		check("manual install: no load errors", result.errors.length === 0, JSON.stringify(result.errors));
		check("manual install: extension discovered", result.extensions.length === 1, `found ${result.extensions.length}`);

		const extension = result.extensions[0];
		if (!extension) return;

		check(
			"manual install: registers a tool_call handler",
			extension.handlers.has("tool_call") && (extension.handlers.get("tool_call")?.length ?? 0) > 0,
		);

		const handler = extension.handlers.get("tool_call")?.[0];
		if (handler) {
			await runFunctionalChecks(handler, "manual install");
		}
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

async function testCliInstallIsDiscoverable(
	discoverAndLoadExtensions: Awaited<ReturnType<typeof loadDiscoverAndLoadExtensions>>,
): Promise<void> {
	// Mirrors README.md "Via pi Marketplace" / local install: `pi install <source>`.
	const agentDir = mkTempDir("pi-e2e-cli-agentdir-");
	try {
		const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };

		execFileSync(process.execPath, [PI_CLI, "install", REPO_ROOT], { env, stdio: "pipe" });

		const listOutput = execFileSync(process.execPath, [PI_CLI, "list"], { env, stdio: "pipe" }).toString();
		check("pi install: appears in `pi list`", listOutput.includes(REPO_ROOT), listOutput);

		const settingsPath = path.join(agentDir, "settings.json");
		check("pi install: writes settings.json", fs.existsSync(settingsPath));

		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
		const configuredPaths: string[] = settings.packages ?? [];
		check("pi install: settings.json references the package", configuredPaths.length > 0, JSON.stringify(settings));

		// Load exactly the way pi would at startup, using the configured path from settings.json.
		const result = await discoverAndLoadExtensions(configuredPaths, agentDir, agentDir);

		check("pi install: no load errors", result.errors.length === 0, JSON.stringify(result.errors));
		check("pi install: extension loads from configured package", result.extensions.length === 1, `found ${result.extensions.length}`);

		const handler = result.extensions[0]?.handlers.get("tool_call")?.[0];
		if (handler) {
			await runFunctionalChecks(handler, "pi install");
		}
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const discoverAndLoadExtensions = await loadDiscoverAndLoadExtensions();

	await testManifestDeclaresResolvableEntry();
	await testManualInstallationIsDiscovered(discoverAndLoadExtensions);
	await testCliInstallIsDiscoverable(discoverAndLoadExtensions);

	console.log("");
	console.log(`Result: ${passed} passed, ${failed} failed out of ${passed + failed} checks.`);
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
