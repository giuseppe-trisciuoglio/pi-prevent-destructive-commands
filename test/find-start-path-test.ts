import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTokens } from "../src/checker";

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "find-start-path-"));
	const outside = mkdtempSync(join(tmpdir(), "non-find-start-path-"));

	try {
		// Safe: default start path and explicit in-boundary paths.
		assert.equal(checkTokens(["find", ".", "-name", "*.ts"], root).dangerous, false);
		assert.equal(checkTokens(["find", "src", "test", "-type", "f"], root).dangerous, false);
		assert.equal(checkTokens(["find"], root).dangerous, false);
		assert.equal(
			checkTokens(["find", join(root, "src"), "-maxdepth", "1"], root).dangerous,
			false,
		);

		// Unsafe: search roots outside the working directory.
		assert.equal(checkTokens(["find", "/etc"], root).dangerous, true);
		assert.equal(checkTokens(["find", ".."], root).dangerous, true);
		assert.equal(checkTokens(["find", "~"], root).dangerous, true);
		assert.equal(checkTokens(["find", outside], root).dangerous, true);
		assert.equal(checkTokens(["find", join(outside, "x")], root).dangerous, true);

		// Unsafe: unresolvable glob as the start path.
		assert.equal(checkTokens(["find", "/tmp/*"], root).dangerous, true);

		// Unsafe: a preceding unresolved `cd` makes relative start paths unverifiable.
		assert.equal(checkTokens(["cd", "-", ";", "find", "."], root).dangerous, true);

		// `cd` inside the boundary still resolves relative starts correctly.
		assert.equal(checkTokens(["cd", "src", "&&", "find", "."], root).dangerous, false);
		// A `cd` that escapes the boundary makes even `.` unsafe.
		assert.equal(checkTokens(["cd", "..", "&&", "find", "."], root).dangerous, true);
		assert.equal(checkTokens(["cd", "src", "&&", "find", ".."], root).dangerous, false);

		// -exec analysis keeps working alongside the new check.
		assert.equal(
			checkTokens(["find", outside, "-maxdepth", "1", "-exec", "rm", "{}", "\\;"], root)
				.dangerous,
			true,
		);

		console.log("find start path tests passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
}

main();
