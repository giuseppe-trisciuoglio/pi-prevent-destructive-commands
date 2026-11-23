import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	extractComments,
	findNewSourceComments,
	sourceCommentBlockReason,
} from "../src/comment-guard";
import { loadProjectConfig, resetProjectConfigCache } from "../src/project-config";
import { runIsolatedTest } from "./helpers";

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

runIsolatedTest(
	"New comments in source files are blocked across write, edit, patch, and bash tools",
	async (root) => {
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

		// ─── Regex literals and desync fail-safe (issue #49) ────────────────

		const noComments = (source: string, message: string) =>
			assert.deepEqual(extractComments(source, "c").map((c) => c.text), [], message);
		noComments(
			"s.replace(/'/g, 'x');\nconst a = 'see js/gimmicks/*.js for kinds';",
			"a quote inside a regex literal must not open a string",
		);
		noComments(
			"s.replace(/\"/g, '');\nconst b = \"src/*.ts list\";",
			"a double quote inside a regex literal must not open a string",
		);
		noComments("const r = a / b; const c = 'js/*.js';", "division followed by a string");
		noComments("s.split(\"'\");\nconst a = 'see js/gimmicks/*.js for kinds';", "split with a quote string");
		noComments("const r = /a\\/*b/;", "a regex body containing /* is not a comment");
		noComments("const t = `${s.replace(/'/g, '')} js/*.js`;", "a template literal containing a regex");
		noComments("const r = /[/'*]/.test(s);\nconst p = 'a/*b';", "a slash and quote inside a regex class");
		noComments("if (ok) return /'/.test(s);\nconst p = 'x/*y';", "a regex literal after return");
		assert.deepEqual(
			extractComments("const x = a / b / c; // real\nconst y = /re/; /* also real */", "c").map((c) => c.text),
			["real", "also real"],
			"division and regex disambiguation keeps real comments",
		);
		assert.deepEqual(
			extractComments("x = /re/g // after regex", "c").map((c) => c.text),
			["after regex"],
			"a comment after a regex literal is still found",
		);
		assert.deepEqual(
			extractComments("const a = 'unterminated /* x */\n// own line\nconst b = 1;", "c").map((c) => c.text),
			["own line"],
			"after a desync only comments that open a line are reported",
		);

		await expectAllowed(
			"write",
			{
				path: "build.js",
				content:
					"const q = (s) => `'${s.replace(/'/g, \"'\\\\''\")}'`;\nconst notes = ['see js/gimmicks/*.js for kinds', 'R1/R17'];\n",
			},
			root,
			"the reported build.js pattern must not be blocked",
		);
		await expectBlocked(
			"write",
			{ path: "regex.ts", content: "const r = /a/g;\n// explanation\nexport { r };\n" },
			root,
			"a real comment after a regex literal must still be blocked",
		);
		await expectAllowed(
			"write",
			{ path: "styles.scss", content: ".a { background: url(/img/a.png); }\n" },
			root,
			"a URL path in a stylesheet is not a regex",
		);
		await expectBlocked(
			"write",
			{ path: "styles.scss", content: ".a { background: url(/img/a.png); } /* note */\n" },
			root,
			"a stylesheet comment after a URL path must still be blocked",
		);
		await expectAllowed(
			"write",
			{ path: join(tmpdir(), `pdc-comment-${process.pid}.js`), content: "// throwaway script\nconsole.log(1);\n" },
			root,
			"files outside the working directory are not project source",
		);
		await expectAllowed(
			"bash",
			{ command: `echo "// note" > ${join(tmpdir(), "pdc-out.ts")}` },
			root,
			"bash writes outside the working directory are not checked",
		);

		// Review findings on PR #52: JSX self-closing tags (finding 1).
		await expectBlocked(
			"write",
			{ path: "jsx1.tsx", content: "const e = <Input value={v} /> // real\n" },
			root,
			"a comment after a JSX self-closing tag with an attribute must be blocked",
		);
		await expectBlocked(
			"write",
			{ path: "jsx2.jsx", content: "const e = <Comp onClick={() => go()} /> // real\n" },
			root,
			"a comment after a JSX self-closing tag with an arrow attribute must be blocked",
		);
		await expectBlocked(
			"write",
			{ path: "jsx3.tsx", content: "const e = <A b={1} /> /* real */\n" },
			root,
			"a block comment after a JSX self-closing tag must be blocked",
		);
		await expectBlocked(
			"write",
			{ path: "jsx4.tsx", content: "const e = (\n\t<div>\n\t\t<A b={1} />{/* real */}\n\t</div>\n);\n" },
			root,
			"a JSX comment right after a self-closing tag must be blocked",
		);
		await expectAllowed(
			"write",
			{ path: "jsx5.tsx", content: "const e = <A b={1} />;\nconst p = 'src/*.ts';\n" },
			root,
			"a JSX self-closing tag followed by a glob string must pass",
		);
		await expectAllowed(
			"write",
			{ path: "jsx6.tsx", content: "const e = <a href={url} />;\nconst u = 'https://x.y/a';\n" },
			root,
			"a JSX self-closing tag followed by a URL string must pass",
		);

		// Finding 2: a desync keeps the comments found before it.
		await expectBlocked(
			"write",
			{ path: "a.rs", content: "let x = 1; // real\nfn f() -> &'static str { \"a\" }\n" },
			root,
			"a comment before a Rust lifetime must be blocked",
		);
		await expectBlocked(
			"write",
			{ path: "b.rs", content: "fn f<'a>(s: &'a str) -> &'a str { s } // real\n" },
			root,
			"a comment after Rust lifetimes on the same line must be blocked",
		);
		await expectAllowed(
			"write",
			{ path: "c.rs", content: "fn f() -> &'static str { \"see src/*.rs\" }\nlet c = 'x';\nlet q = '\\'';\n" },
			root,
			"Rust lifetimes and char literals must not desync the scan",
		);
		assert.deepEqual(
			extractComments("let x = 1; // real\nconst s = 'unterminated", "c").map((c) => c.text),
			["real"],
			"a desync at EOF keeps the comments scanned before the failing string",
		);
		assert.deepEqual(
			extractComments("/* before */ const s = 'open\n// own line\nconst t = 'a/*b';\n", "c").map((c) => [c.line, c.text]),
			[
				[1, "before"],
				[2, "own line"],
			],
			"a desync on a multi-line JS string keeps earlier comments and falls back only after it, without duplicates",
		);
		assert.deepEqual(
			extractComments("// a\n// b\nconst s = 'x\n// c", "c").map((c) => [c.line, c.text]),
			[
				[1, "a"],
				[2, "b"],
				[4, "c"],
			],
			"fallback line numbers stay absolute and scanned comments are not duplicated",
		);
		await expectBlocked(
			"write",
			{ path: "desync.ts", content: "const x = 1; // real\nconst s = 'open\nnext';\n" },
			root,
			"a comment before a desynchronising JS string must be blocked",
		);
		await expectAllowed(
			"write",
			{ path: "desync2.ts", content: "const x = 1;\nconst s = 'open\nnext /* not */ x';\n" },
			root,
			"a mid-line marker after a desync must still pass",
		);

		// Finding 3: division after postfix operators and non-null assertions.
		for (const [source, label] of [
			["const r = i++ / count; // real", "i++"],
			["const r = i-- / count; // real", "i--"],
			["total! / count; // real", "total!"],
			["const r = f()! / count; // real", "f()!"],
			["const r = a[0]! / count; // real", "a[0]!"],
			["const x = {a} / 2; // real", "{a}"],
		] as const) {
			assert.deepEqual(
				extractComments(source, "c").map((c) => c.text),
				["real"],
				`a division after ${label} must not hide the trailing comment`,
			);
		}
		await expectBlocked(
			"write",
			{ path: "div.ts", content: "const r = i++ / count; // real\n" },
			root,
			"a comment after a division following i++ must be blocked",
		);
		noComments("const ok = !/'/.test(s);\nconst p = 'a/*b';", "a regex after a prefix ! is still a regex");
		noComments("x = a + +/'/.test(s).length;\nconst p = 'a/*b';", "a regex after a unary + is still a regex");
		noComments("if (a) { /'/.test(s); }\nconst p = 'a/*b';", "a regex after { is still a regex");

		// Finding 5: a `..foo` directory is inside the project.
		mkdirSync(join(root, "..foo"), { recursive: true });
		await expectBlocked(
			"write",
			{ path: "..foo/x.ts", content: "// real\nexport {};\n" },
			root,
			"a file under a ..foo directory is project source",
		);
		await expectAllowed(
			"write",
			{ path: "../outside-pdc.ts", content: "// real\nexport {};\n" },
			root,
			"a file in the parent directory is outside the project",
		);
		rmSync(join(root, "..foo"), { recursive: true, force: true });

		// ─── Reported line is the file line (issue #54) ─────────────────────

		const lineRoot = join(root, "lines");
		mkdirSync(lineRoot, { recursive: true });
		const pyLines = Array.from({ length: 20 }, (_, i) => `v${i} = ${i}`);
		pyLines[16] = "x = 1  # old";
		writeFileSync(join(lineRoot, "a.py"), pyLines.join("\n") + "\n");
		const edited = await findNewSourceComments(
			"edit",
			{ path: "a.py", edits: [{ oldText: "x = 1  # old", newText: "x = 1  # new" }] },
			lineRoot,
		);
		assert.equal(edited?.line, 17, "a one-line edit reports the file line");
		assert.ok(sourceCommentBlockReason(edited!).includes("a.py:17"));
		assert.ok(sourceCommentBlockReason(edited!).includes("Rewording an existing comment"));

		const multiLine = await findNewSourceComments(
			"edit",
			{ path: "a.py", edits: [{ oldText: "x = 1  # old", newText: "x = 1\ny = 2  # new" }] },
			lineRoot,
		);
		assert.equal(multiLine?.line, 18, "a comment on the 2nd newText line reports match line + 1");

		const secondEdit = await findNewSourceComments(
			"edit",
			{
				path: "a.py",
				edits: [
					{ oldText: "v2 = 2", newText: "v2 = 3" },
					{ oldText: "v9 = 9", newText: "v9 = 9  # c" },
				],
			},
			lineRoot,
		);
		assert.equal(secondEdit?.line, 10, "each edits[] entry is located on its own");

		const ambiguous = await findNewSourceComments(
			"edit",
			{ path: "a.py", edits: [{ oldText: "v1", newText: "v1  # c" }] },
			lineRoot,
		);
		assert.equal(ambiguous?.line, 1, "a non-unique oldText falls back to the snippet line");
		const missing = await findNewSourceComments(
			"edit",
			{ path: "a.py", edits: [{ oldText: "nope", newText: "nope  # c" }] },
			lineRoot,
		);
		assert.equal(missing?.line, 1, "a missing oldText falls back to the snippet line");
		const noFile = await findNewSourceComments(
			"edit",
			{ path: "gone.py", edits: [{ oldText: "a", newText: "a  # c" }] },
			lineRoot,
		);
		assert.equal(noFile?.line, 1, "an unreadable file falls back to the snippet line");

		const hunk = await findNewSourceComments(
			"apply_patch",
			{ input: "--- a/a.py\n+++ b/a.py\n@@ -15,4 +15,5 @@\n v14 = 14\n-v15 = 15\n+v15 = 16\n+# note\n v16 = 16\n" },
			lineRoot,
		);
		assert.equal(hunk?.line, 17, "a unified-diff hunk header gives the file line");
		const patchNoHeader = await findNewSourceComments(
			"apply_patch",
			{ input: "*** Begin Patch\n*** Update File: a.py\n@@ context\n v1 = 1\n+# note\n*** End Patch" },
			lineRoot,
		);
		assert.equal(patchNoHeader?.line, 3, "a bare @@ hunk is located by its context");
		const lineOf = async (tool: string, input: Record<string, unknown>) =>
			(await findNewSourceComments(tool, input, lineRoot))?.line;
		const openai = (body: string) => ({ input: `*** Begin Patch\n*** Update File: a.py\n${body}\n*** End Patch` });
		assert.equal(await lineOf("apply_patch", openai("@@\n v2 = 2\n+# c")), 4, "bare @@ is located in the file");
		assert.equal(
			await lineOf("apply_patch", openai("@@ v9 = 9\n v10 = 10\n+# c")),
			12,
			"@@ context text narrows the search",
		);
		assert.equal(await lineOf("apply_patch", openai("@@\n zz = 0\n+# c")), 1, "no match falls back");
		writeFileSync(join(lineRoot, "dup.py"), "a = 1\na = 1\n");
		assert.equal(
			(await findNewSourceComments("apply_patch", { input: "*** Begin Patch\n*** Update File: dup.py\n@@\n a = 1\n+# c\n*** End Patch" }, lineRoot))?.line,
			1,
			"an ambiguous match falls back",
		);
		assert.equal(
			await lineOf("apply_patch", {
				input: "--- a/a.py\n+++ b/a.py\n@@ -3,3 +3,4 @@\n v3 = 3\n-v4 = 4\n+v4 = 5\n\\ No newline at end of file\n+# c\n",
			}),
			5,
			"a no-newline marker is not a context line",
		);
		assert.equal(
			await lineOf("apply_patch", { input: "--- a/a.py\n+++ b/a.py\n@@ -3,2 +3,3 @@\n a\n--- x\n+# c\n b\n" }),
			4,
			"a removed line starting with -- is not a file header",
		);

		writeFileSync(join(lineRoot, "crlf.py"), "a = 1\r\nb = 2\r\nc = 3\r\n");
		assert.equal(
			(await findNewSourceComments("edit", { path: "crlf.py", edits: [{ oldText: "b = 2\nc = 3", newText: "b = 2\nc = 3  # c" }] }, lineRoot))?.line,
			3,
			"CRLF files are matched with LF oldText",
		);

		if (process.platform !== "win32") {
			const { spawnSync } = await import("node:child_process");
			const fifo = join(lineRoot, "pipe.py");
			if (spawnSync("mkfifo", [fifo]).status === 0) {
				const result = await Promise.race([
					findNewSourceComments("edit", { path: "pipe.py", edits: [{ oldText: "a", newText: "a  # c" }] }, lineRoot),
					new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 3000)),
				]);
				assert.notEqual(result, "timeout", "a FIFO target must not block the guard");
				assert.equal((result as { line: number }).line, 1);
			}
		}
		writeFileSync(join(lineRoot, "blank.py"), "a=1\n\nb=2\nc=3\n");
		assert.equal(
			(await findNewSourceComments("apply_patch", { input: "--- a/blank.py\n+++ b/blank.py\n@@ -1,3 +1,4 @@\n a=1\n\n b=2\n+# c\n c=3\n\n" }, lineRoot))?.line,
			4,
			"a stripped blank context line counts in +start numbering",
		);
		assert.equal(
			(await findNewSourceComments("apply_patch", { input: "*** Begin Patch\n*** Update File: blank.py\n@@\n a=1\n\n b=2\n+# c\n c=3\n\n*** End Patch" }, lineRoot))?.line,
			4,
			"a stripped blank context line counts in the bare @@ search",
		);
		assert.equal(
			(await findNewSourceComments("apply_patch", { input: "--- a/blank.py\n+++ b/blank.py\n@@ -1,3 +1,4 @@\n a=1\n+# c\n\n\n" }, lineRoot))?.line,
			2,
			"trailing blank lines shift nothing",
		);
		assert.equal(
			(await findNewSourceComments("apply_patch", { input: "--- a/blank.py\n+++ b/blank.py\n@@ -0 +99999999999999999999 @@\n+# c\n" }, lineRoot))?.line,
			1,
			"an absurd +start falls back",
		);

		await expectAllowed(
			"apply_patch",
			{ input: "--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,1 @@\n--- old\n+-- old\n" },
			lineRoot,
			"a removed '-- old' re-added unchanged is not a new comment (sql)",
		);
		writeFileSync(join(lineRoot, "q.sql"), "-- old\nselect 1;\n");
		await expectAllowed(
			"apply_patch",
			{ input: "--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +1,2 @@\n--- old\n+-- old\n select 1;\n" },
			lineRoot,
			"a removed '-- old' re-added unchanged is allowed",
		);
		await expectBlocked(
			"apply_patch",
			{ input: "--- a/q.sql\n+++ b/q.sql\n@@ -1,1 +1,2 @@\n select 1;\n+++ -- c\n" },
			lineRoot,
			"an added '+++ -- c' line is a new comment",
		);
		await expectBlocked(
			"apply_patch",
			{ input: "--- a/a.py\n+++ b/a.py\n@@ -1,1 +1,2 @@\n v0 = 0\n+++ # c\n" },
			lineRoot,
			"an added '+++ # c' line is a new comment",
		);

		writeFileSync(join(lineRoot, "big.py"), "x = 1\n".repeat(300_000));
		const startedAt = Date.now();
		const bigViolation = await findNewSourceComments(
			"apply_patch",
			{ input: `*** Begin Patch\n*** Update File: big.py\n@@\n${" x = 1\n".repeat(2999)} y = 2\n+# c\n*** End Patch` },
			lineRoot,
		);
		assert.ok(Date.now() - startedAt < 200, `hunk search must stay bounded (${Date.now() - startedAt} ms)`);
		assert.ok(bigViolation !== undefined);
		rmSync(lineRoot, { recursive: true, force: true });

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
	},
);
