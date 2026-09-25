import assert from "node:assert/strict";
import { checkCommand } from "../src/checker";

async function main(): Promise<void> {
	const cwd = process.cwd();

	// Blocked: gh api with destructive method, both flag forms.
	for (const command of [
		"gh api -X DELETE repos/owner/name",
		"gh api --method DELETE repos/owner/name",
		"gh api repos/owner/name -X DELETE",
		"gh api --method=DELETE repos/owner/name",
		"echo hi && gh api -X DELETE repos/owner/name",
	]) {
		const r = checkCommand(command, cwd);
		assert.equal(r.dangerous, true, `expected block: ${command}`);
	}

	// Blocked: destructive gh subcommands.
	for (const command of [
		"gh repo delete owner/name --yes",
		"gh repo rename new-name --yes",
		"gh release delete v1.0.0 --yes",
		"gh gist delete abc123",
		"gh secret delete MY_SECRET",
		"gh variable delete MY_VAR",
		"gh label delete bug",
		"gh run delete 12345",
	]) {
		const r = checkCommand(command, cwd);
		assert.equal(r.dangerous, true, `expected block: ${command}`);
	}

	// Allowed: safe gh usage.
	for (const command of [
		"gh api repos/owner/name",
		"gh api -X GET repos/owner/name",
		"gh api --method POST repos/owner/name/issues -f title=hi",
		"gh pr view 14",
		"gh repo view owner/name",
		"gh release list",
	]) {
		const r = checkCommand(command, cwd);
		assert.equal(r.dangerous, false, `expected allow: ${command} — ${r.reason}`);
	}

	console.log("gh-guard-test: OK");
}

main();
