import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractComments,
	findNewSourceComments,
	sourceCommentBlockReason,
} from "../src/comment-guard";
import { loadProjectConfig, resetProjectConfigCache } from "../src/project-config";

async function expectBlocked(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	message: string,
): Promise<void> {
	const violation = await findNewSourceComments(toolName, input, cwd);
	assert.ok(violation !== undefined, message);
	assert.ok(sourceCommentBlockReason(violation).includes(violation.path));
}

async function expectAllowed(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	message: string,
): Promise<void> {
	const violation = await findNewSourceComments(toolName, input, cwd);
	assert.equal(violation, undefined, message);
}

async function main(): Promise<void> {
	const root = mkdtempSync(join(tmpdir(), "comment-guard-"));

	try {
		// ─── Comment extraction ─────────────────────────────────────────────

		const javaComments = extractComments(
			["package demo;", "", "public class Foo {", "\t// explanation", "\t/* block", "\t   note */", "}"].join("\n"),
			"c",
		);
		assert.deepEqual(
			javaComments.map((comment) => [comment.line, comment.text]),
			[
				[4, "explanation"],
				[5, "block\n\t   note"],
			],
		);

		assert.deepEqual(
			extractComments('const url = "https://example.com";\nconst s = \'/*\';\nconst t = `// not`;', "c").map(
				(comment) => comment.text,
			),
			[],
		);

		assert.deepEqual(extractComments('"""docstring with # inside"""\nx = 1', "hash", true), []);
		assert.deepEqual(
			extractComments("#!/usr/bin/env python3\n# real comment\nvalue = 1", "hash", true).map(
				(comment) => comment.text,
			),
			["!/usr/bin/env python3", "real comment"],
		);

		assert.deepEqual(extractComments("a { color: red; } /* note */", "block").map((c) => c.text), ["note"]);
		assert.deepEqual(extractComments("a { color: red; } // not css", "block"), []);
		assert.deepEqual(extractComments("SELECT 1; -- note\n/* block */", "dash").map((c) => c.text), [
			"note",
			"block",
		]);
		assert.deepEqual(extractComments("<p>text</p><!-- note -->", "html").map((c) => c.text), ["note"]);

		// ─── write tool ─────────────────────────────────────────────────────

		await expectBlocked(
			"write",
			{ path: "Foo.java", content: "public class Foo {\n\t// explanation\n}\n" },
			root,
			"a new Java file with a line comment must be blocked",
		);
		const violation = await findNewSourceComments(
			"write",
			{ path: "Foo.java", content: "public class Foo {\n\t// explanation\n}\n" },
			root,
		);
		assert.equal(violation?.line, 2);
		assert.equal(violation?.comment, "explanation");

		await expectAllowed(
			"write",
			{ path: "Foo.java", content: "public class Foo {\n\tint count = 0;\n}\n" },
			root,
			"a Java file without comments must pass",
		);
		await expectAllowed(
			"write",
			{ path: "service.ts", content: 'const url = "https://example.com";\nexport {};\n' },
			root,
			"comment markers inside string literals must not block",
		);
		await expectAllowed(
			"write",
			{ path: "keep.ts", content: "const marker = '/*';\nexport {};\n" },
			root,
			"block-comment markers inside string literals must not block",
		);
		await expectBlocked(
			"write",
			{ path: "widget.dart", content: "class Widget {\n\t/* multi\n\tline note */\n}\n" },
			root,
			"a Dart block comment must be blocked",
		);
		await expectBlocked("write", { path: "script.py", content: "# helper\nvalue = 1\n" }, root, "a Python hash comment must be blocked");
		await expectBlocked(
			"write",
			{ path: "query.sql", content: "-- fetch users\nSELECT 1;\n" },
			root,
			"an SQL dash comment must be blocked",
		);
		await expectBlocked(
			"write",
			{ path: "page.html", content: "<div>\n\t<!-- header -->\n</div>\n" },
			root,
			"an HTML comment must be blocked",
		);
		await expectAllowed(
			"write",
			{ path: "notes.md", content: "# Title\n\nSome prose with # hash and // slashes.\n" },
			root,
			"markdown prose must pass",
		);
		await expectAllowed(
			"write",
			{ path: "data.json", content: '{ "note": "// not a comment" }\n' },
			root,
			"non-source files must pass",
		);

		// Shebangs and tooling directives stay allowed.
		await expectAllowed(
			"write",
			{ path: "run.py", content: "#!/usr/bin/env python3\nvalue = 1\n" },
			root,
			"shebang lines must be allowed",
		);
		await expectAllowed(
			"write",
			{
				path: "legacy.ts",
				content: "// @ts-ignore\n// eslint-disable-next-line no-console\nconsole.log(1);\n// biome-ignore format: lint/suspicious/noConsole: needed here\n",
			},
			root,
			"recognized tooling directives must be allowed",
		);
		await expectAllowed(
			"write",
			{ path: "legacy.py", content: "value = 1  # noqa: E501\n" },
			root,
			"noqa directives must be allowed",
		);
		await expectAllowed(
			"write",
			{ path: "divider.ts", content: "//\n// ────────────\nexport {};\n" },
			root,
			"purely decorative comments must be allowed",
		);

		// Writing over an existing file may carry its comments over untouched.
		mkdirSync(join(root, "existing"), { recursive: true });
		writeFileSync(join(root, "existing", "svc.ts"), "import { x } from \"y\";\n// keep me\nexport const z = x;\n");
		await expectAllowed(
			"write",
			{
				path: "existing/svc.ts",
				content: "import { x } from \"y\";\n// keep me\nexport const z = x + 1;\n",
			},
			root,
			"rewriting a file may carry over its existing comments",
		);
		await expectBlocked(
			"write",
			{
				path: "existing/svc.ts",
				content: "import { x } from \"y\";\n// keep me\n// plus this one\nexport const z = x + 1;\n",
			},
			root,
			"adding a new comment to an existing file must be blocked",
		);

		// ─── edit tool ──────────────────────────────────────────────────────

		await expectAllowed(
			"edit",
			{
				path: "svc.ts",
				edits: [
					{
						oldText: "// keep me\nexport const z = x;",
						newText: "// keep me\nexport const z = x + 1;",
					},
				],
			},
			root,
			"an edit keeping an existing comment must pass",
		);
		await expectBlocked(
			"edit",
			{
				path: "svc.ts",
				edits: [{ oldText: "export const z = x;", newText: "// explanation\nexport const z = x;" }],
			},
			root,
			"an edit introducing a new comment must be blocked",
		);

		// ─── apply_patch ────────────────────────────────────────────────────

		await expectBlocked(
			"__apply_patch",
			{
				input: [
					"*** Begin Patch",
					"*** Update File: svc.ts",
					"@@",
					" export const z = x;",
					"+// explanation",
					"*** End Patch",
				].join("\n"),
			},
			root,
			"a patch adding a comment line must be blocked",
		);
		await expectAllowed(
			"__apply_patch",
			{
				input: [
					"*** Begin Patch",
					"*** Update File: svc.ts",
					"@@",
					" // keep me",
					" export const z = x;",
					"-export const z = x;",
					"+export const z = x + 1;",
					"*** End Patch",
				].join("\n"),
			},
			root,
			"a patch without new comments must pass",
		);
		await expectBlocked(
			"__apply_patch",
			{
				input: [
					"*** Begin Patch",
					"*** Add File: new-file.java",
					"+public class NewFile {",
					"+\t// why this exists",
					"+}",
					"*** End Patch",
				].join("\n"),
			},
			root,
			"an added file with a comment must be blocked",
		);
		await expectBlocked(
			"__apply_patch",
			{
				patch: [
					"--- a/svc.ts",
					"+++ b/svc.ts",
					"@@ -1 +1,2 @@",
					" export const z = x;",
					"+// explanation",
				].join("\n"),
			},
			root,
			"a unified diff adding a comment line must be blocked",
		);
		await expectAllowed(
			"__apply_patch",
			{
				patch: [
					"--- a/svc.ts",
					"+++ b/svc.ts",
					"@@ -1,2 +1,2 @@",
					" // keep me",
					"-export const z = x;",
					"+export const z = x + 1;",
				].join("\n"),
			},
			root,
			"a unified diff without new comments must pass",
		);

		// Pure renames carry content over unchanged.
		await expectAllowed(
			"__apply_patch",
			{
				input: [
					"*** Begin Patch",
					"*** Update File: svc.ts",
					"*** Move to: renamed.ts",
					"*** End Patch",
				].join("\n"),
			},
			root,
			"a pure rename must pass",
		);

		// ─── bash write vectors ─────────────────────────────────────────────

		await expectBlocked(
			"bash",
			{ command: "cat > a.ts <<'EOF'\nconst a = 1;\n// note about a\nEOF" },
			root,
			"a heredoc comment written into a TypeScript file must be blocked",
		);
		await expectBlocked(
			"bash",
			{ command: "tee b.py <<EOF\nvalue = 1\n# note\nEOF" },
			root,
			"a heredoc comment written through tee must be blocked",
		);
		await expectBlocked(
			"bash",
			{ command: 'echo "// x" >> c.ts' },
			root,
			"an echo comment appended to a source file must be blocked",
		);
		await expectBlocked(
			"bash",
			{ command: "printf '# comment\\n' > e.py" },
			root,
			"a printf comment written into a source file must be blocked",
		);
		await expectAllowed(
			"bash",
			{ command: "cat > notes.md <<'EOF'\n# Title with // slashes\nprose\nEOF" },
			root,
			"a heredoc into a markdown file must pass",
		);
		await expectAllowed(
			"bash",
			{ command: 'echo "const u = \'https://example.com\';" > d.ts' },
			root,
			"echoing string literals without comments must pass",
		);
		await expectAllowed(
			"bash",
			{ command: "cat a.ts > /dev/null" },
			root,
			"reading commands must not be affected",
		);

		// ─── Tools without file text ────────────────────────────────────────

		await expectAllowed("rename_refactoring", { pathInProject: "svc.ts" }, root, "renames carry no new text");
		await expectAllowed("apply_quick_fix", { filePath: "svc.ts" }, root, "quick fixes carry no agent text");

		// ─── Per-project opt-out ────────────────────────────────────────────

		mkdirSync(join(root, ".pi"), { recursive: true });
		assert.equal(loadProjectConfig(root).disableCommentGuard, false);
		writeFileSync(join(root, ".pi", "prevent-destructive-commands.json"), '{"disableCommentGuard": true}');
		resetProjectConfigCache();
		assert.equal(loadProjectConfig(root).disableCommentGuard, true);
		assert.equal(loadProjectConfig(root).disableGitGuards, false);
		rmSync(join(root, ".pi"), { recursive: true, force: true });
		resetProjectConfigCache();

		console.log("PASS  New comments in source files are blocked across write, edit, patch, and bash tools");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
