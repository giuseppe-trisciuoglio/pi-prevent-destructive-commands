import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findDrizzleMigrationDirectories,
	isDrizzleMigrationPath,
	isPotentialMigrationMutation,
} from "../src/migration-guard";

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "drizzle-migration-guard-"));
	try {
		mkdirSync(join(root, "apps", "api"), { recursive: true });
		writeFileSync(
			join(root, "drizzle.config.ts"),
			'export default { out: "./database/migrations" };\n',
		);

		const directories = await findDrizzleMigrationDirectories(join(root, "apps", "api"));
		assert.deepEqual(directories, [join(root, "database", "migrations")]);
		assert.equal(isDrizzleMigrationPath("database/migrations/0001_init.sql", root, directories), true);
		assert.equal(isDrizzleMigrationPath("database/schema.ts", root, directories), false);
		assert.equal(isPotentialMigrationMutation("sed -i 's/a/b/' database/migrations/0001_init.sql"), true);
		assert.equal(isPotentialMigrationMutation("echo sql > database/migrations/0001_init.sql"), true);
		assert.equal(isPotentialMigrationMutation("npx drizzle-kit generate"), false);

		console.log("PASS  Drizzle migration directories are read from configuration and direct mutations are detected");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
