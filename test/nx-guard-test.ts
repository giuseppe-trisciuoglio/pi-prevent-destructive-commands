import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findNxConfigurationMutation,
	findNxWorkspaceRoot,
	isNxConfigurationPath,
	isPotentialNxConfigurationMutation,
} from "../src/nx-guard";

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "nx-guard-"));
	const outside = mkdtempSync(join(tmpdir(), "non-nx-guard-"));

	try {
		mkdirSync(join(root, "apps", "web"), { recursive: true });
		writeFileSync(join(root, "nx.json"), "{}\n");
		writeFileSync(join(root, "package.json"), "{}\n");
		writeFileSync(join(root, "tsconfig.json"), "{}\n");
		writeFileSync(join(root, "tsconfig.base.json"), "{}\n");
		writeFileSync(join(root, "tsconfig.spec.json"), "{}\n");
		writeFileSync(join(root, "apps", "web", "tsconfig.lib.json"), "{}\n");

		assert.equal(await findNxWorkspaceRoot(join(root, "apps", "web")), root);
		assert.equal(await findNxWorkspaceRoot(outside), undefined);
		assert.equal(isNxConfigurationPath("apps/web/tsconfig.lib.json", root, root), true);
		assert.equal(isNxConfigurationPath("apps/web/project.json", root, root), false);
		assert.equal(isNxConfigurationPath("../package.json", root, root), false);

		assert.equal(
			await findNxConfigurationMutation("write", { path: "package.json" }, root),
			"package.json",
		);
		for (const path of [
			"tsconfig.json",
			"tsconfig.base.json",
			"tsconfig.spec.json",
			"apps/web/tsconfig.lib.json",
		]) {
			assert.equal(await findNxConfigurationMutation("edit", { path }, root), path);
		}
		assert.equal(
			await findNxConfigurationMutation("write", { path: "apps/api/tsconfig.spec.json" }, root),
			undefined,
		);
		assert.equal(
			await findNxConfigurationMutation(
				"phpstorm__apply_patch",
				{ input: "*** Begin Patch\n*** Update File: tsconfig.base.json\n*** End Patch" },
				root,
			),
			"tsconfig.base.json",
		);
		assert.equal(
			await findNxConfigurationMutation(
				"phpstorm__apply_patch",
				{ input: "*** Begin Patch\n*** Add File: apps/api/tsconfig.spec.json\n*** End Patch" },
				root,
			),
			undefined,
		);
		assert.equal(
			await findNxConfigurationMutation(
				"phpstorm__apply_patch",
				{ input: "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@" },
				root,
			),
			"package.json",
		);
		assert.equal(
			await findNxConfigurationMutation("bash", { command: "echo '{}' > package.json" }, root),
			"package.json",
		);
		assert.equal(
			await findNxConfigurationMutation(
				"bash",
				{ command: "bash -c \"echo '{}' > package.json\"" },
				root,
			),
			"package.json",
		);
		assert.equal(
			await findNxConfigurationMutation("bash", { command: "cp package.json backup.json" }, root),
			undefined,
		);
		assert.equal(
			await findNxConfigurationMutation("bash", { command: "pnpm add zod" }, root),
			join(root, "package.json"),
		);
		assert.equal(
			await findNxConfigurationMutation("bash", { command: "cat package.json" }, root),
			undefined,
		);
		assert.equal(isPotentialNxConfigurationMutation("sed -i 's/a/b/' package.json"), true);
		assert.equal(isPotentialNxConfigurationMutation("pnpm add zod"), true);
		assert.equal(isPotentialNxConfigurationMutation("cat package.json"), false);

		console.log("PASS  Existing Nx package and TypeScript configuration files are protected while missing files remain creatable");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
