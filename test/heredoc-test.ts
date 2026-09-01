/**
 * Standalone test for heredoc handling in the checker.
 * Does not depend on pi: can be run with:
 *   npx tsx test/heredoc-test.ts
 */

import { checkCommand } from "../src/checker";

const CWD = "/home/user/projects/demo";

interface Case {
	command: string;
	expectBlocked: boolean;
	note?: string;
}

const cases: Case[] = [
	// ─── Heredoc bodies are data, not command lines ───────────────────────────
	{
		command: `cat > docs/nota.md <<'EOF'
# Nota
Questo documento descrive la struttura del **progetto** e i dettagli del [setup](../setup.md).
Vedi anche l'uso del *glob* e del /Users/giuseppe/backup.
EOF`,
		expectBlocked: false,
		note: "Italian prose with 'del' + markdown glob / absolute path inside a quoted heredoc",
	},
	{
		command: `cat > file.md <<EOF
La copia del /Users/giuseppe/backup non è permessa, né del ~/.ssh/config.
EOF`,
		expectBlocked: false,
		note: "unquoted delimiter, prose only, data sink (cat)",
	},
	{
		command: `tee /tmp/x.txt <<'JSON'
{"key": "value del [array] e del *star*"}
JSON`,
		expectBlocked: false,
		note: "other data sinks are skipped too",
	},
	{
		command: `cat <<'EOF'
EOF`,
		expectBlocked: false,
		note: "empty body",
	},
	{
		command: `cat <<- 'EOF'
	testo del **file** con tab
	EOF`,
		expectBlocked: false,
		note: "<<- terminator with leading tabs",
	},
	{
		command: `echo start; cat > a.txt <<'EOF'
del /etc/passwd nel testo
EOF
echo done`,
		expectBlocked: false,
		note: "heredoc starting on a later line of a multi-line command",
	},
	{
		command: `cat <<A <<B
prosa del **primo** corpo
A
ancora prosa del /Users/assoluto
B`,
		expectBlocked: false,
		note: "two heredocs on one line, both bodies consumed in order",
	},
	{
		command: `sh -c 'cat > f <<EOF
testo del **file** dentro bash -c
EOF'`,
		expectBlocked: false,
		note: "heredoc nested inside a shell -c string",
	},

	// ─── Heredoc bodies that ARE executed stay analyzed ───────────────────────
	{
		command: `bash <<'EOF'
rm -rf /etc
EOF`,
		expectBlocked: true,
		note: "body fed to a shell is executed",
	},
	{
		command: `cat <<'EOF' | bash
rm ~/.ssh/id_rsa
EOF`,
		expectBlocked: true,
		note: "body piped into a shell through the command line",
	},
	{
		command: `python3 <<'PY'
rm /etc/passwd
PY`,
		expectBlocked: true,
		note: "interpreter reading from stdin: body analyzed at token level",
	},
	{
		command: `bash -c 'bash <<EOF
rm -rf ~
EOF'`,
		expectBlocked: true,
		note: "executor heredoc nested inside bash -c",
	},
	{
		command: `ssh prod <<'EOF'
rm -rf /var/log
EOF`,
		expectBlocked: true,
		note: "body executed on a remote host",
	},
	{
		command: `bash <<'EOF'
cat > inner.txt <<INNER
prosa innocua del **testo**
INNER
rm /etc/hosts
EOF`,
		expectBlocked: true,
		note: "inner data heredoc skipped, surrounding lines still analyzed",
	},
	{
		command: `bash <<'EOF'
echo del testo innocuo
EOF`,
		expectBlocked: false,
		note: "prose under an executor is fine unless a path-like word follows",
	},

	// ─── Conservative bail-out keeps the legacy whole-string analysis ────────
	{
		command: `cat <<EOF
del /etc/passwd
(no terminator)`,
		expectBlocked: true,
		note: "missing terminator: extraction bails, whole string analyzed as before",
	},
	{
		command: `cat <<$DELIM
del /etc/passwd
$DELIM`,
		expectBlocked: true,
		note: "variable delimiter: not statically knowable, bail out",
	},
	{
		command: `cat <<< del /etc/passwd`,
		expectBlocked: true,
		note: "here-string: untouched by extraction (legacy token behavior)",
	},
];

let passed = 0;
let failed = 0;

for (const c of cases) {
	const result = checkCommand(c.command, CWD);
	const blocked = result.dangerous;
	const ok = blocked === c.expectBlocked;
	const status = ok ? "PASS" : "FAIL";
	if (ok) passed++;
	else failed++;
	const tag = c.expectBlocked ? "block " : "allow";
	const note = c.note ? `  (${c.note})` : "";
	const reason = blocked && !ok ? `  -> ${result.reason}` : "";
	const firstLine = c.command.split("\n")[0];
	console.log(`${status}  [${tag}]  ${firstLine}${note}${reason}`);
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed out of ${cases.length} cases.`);
if (failed > 0) {
	process.exit(1);
}
