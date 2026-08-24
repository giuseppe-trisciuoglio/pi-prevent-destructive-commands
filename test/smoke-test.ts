/**
 * Standalone smoke test for tokenizer + checker.
 * Does not depend on pi: can be run with:
 *   npx tsx test/smoke-test.ts
 *   npx jiti test/smoke-test.ts
 */

import { tokenize } from "../src/tokenizer";
import { checkTokens } from "../src/checker";

const CWD = "/home/user/projects/demo";

interface Case {
	command: string;
	expectBlocked: boolean;
	note?: string;
}

const cases: Case[] = [
	// ─── Destructive Git ──────────────────────────────────────────────────────
	{ command: "git reset --hard", expectBlocked: true },
	{ command: "git reset --hard HEAD~3", expectBlocked: true },
	{ command: "git clean -fd", expectBlocked: true },
	{ command: "git clean -n", expectBlocked: false, note: "dry-run allowed" },
	{ command: "git push --force origin main", expectBlocked: true },
	{ command: "git push -f origin main", expectBlocked: true },
	{ command: "git push --force-with-lease", expectBlocked: true },
	{ command: "git push origin main", expectBlocked: true, note: "push guard active by default" },
	{ command: "git push --delete origin feature", expectBlocked: true },
	{ command: "git branch -D old-feature", expectBlocked: true },
	{ command: "git branch -d old-feature", expectBlocked: false, note: "-d is safe" },
	{ command: "git tag -d v1.0", expectBlocked: true },
	{ command: "git checkout -f .", expectBlocked: true },
	{ command: "git rebase main", expectBlocked: true },
	{ command: "git filter-branch --HEAD", expectBlocked: true },
	{ command: "git reflog expire --expire=now --all", expectBlocked: true },
	{ command: "git update-ref -d refs/heads/x", expectBlocked: true },

	// ─── Git add/commit (flag enabled) ────────────────────────────────────────
	{ command: "git add .", expectBlocked: true },
	{ command: "git commit -m 'wip'", expectBlocked: true },

	// ─── Git global flags before subcommand (-C, -c, --git-dir, ...) ───────────
	{ command: "git -C /tmp/repo reset --hard", expectBlocked: true, note: "global flag -C" },
	{ command: "git -C /tmp/repo commit -m x", expectBlocked: true, note: "global flag -C" },
	{ command: "git -C /tmp/repo push --force origin main", expectBlocked: true, note: "global flag -C" },
	{ command: "git --git-dir=/tmp/x reset --hard", expectBlocked: true, note: "global flag with =" },
	{ command: "git --git-dir /tmp/x --work-tree /tmp/y push --force", expectBlocked: true, note: "separated global flags" },
	{ command: "git --no-pager -C /tmp/x log", expectBlocked: false, note: "global flags, safe subcommand" },
	{ command: "git -c core.editor=vim status", expectBlocked: false, note: "global flag -c with safe subcommand" },

	// ─── rm / path-sensitive ──────────────────────────────────────────────────
	{ command: "rm ./dist/build.js", expectBlocked: false, note: "inside cwd" },
	{ command: "rm dist/old.log", expectBlocked: false, note: "inside cwd" },
	{ command: "rm /etc/passwd", expectBlocked: true, note: "outside cwd" },
	{ command: "rm ~/.ssh/id_rsa", expectBlocked: true, note: "outside cwd" },
	{ command: "rm ../../secret.txt", expectBlocked: true, note: "outside cwd" },
	{ command: "rm -rf /", expectBlocked: true, note: "outside cwd" },
	{ command: "rmdir /tmp/old", expectBlocked: true },
	{ command: "shred ./secrets.txt", expectBlocked: false, note: "inside cwd" },

	// ─── cd tracking ────────────────────────────────────────────────────────
	{
		command: "cd /; rm etc/passwd",
		expectBlocked: true,
		note: "cd shifts effective cwd to /, so etc/passwd resolves to /etc/passwd (outside real cwd)",
	},
	{
		command: "cd /tmp && rm -rf secrets",
		expectBlocked: true,
		note: "cd shifts effective cwd to /tmp, target resolves outside real cwd",
	},
	{
		command: "cd ..; rm secret.txt",
		expectBlocked: true,
		note: "cd .. moves effective cwd to the parent of the real cwd",
	},
	{
		command: "cd ./dist && rm build.js",
		expectBlocked: false,
		note: "cd into a subdirectory of cwd: target still resolves inside the real cwd",
	},
	{
		command: "cd \"$SOME_VAR\" && rm x",
		expectBlocked: true,
		note: "cd target is a variable: effective cwd becomes unresolvable, so subsequent rm is blocked conservatively",
	},

	// ─── Docker ───────────────────────────────────────────────────────────────
	{ command: "docker rm abc", expectBlocked: true },
	{ command: "docker rmi img:latest", expectBlocked: true },
	{ command: "docker container rm abc", expectBlocked: true },
	{ command: "docker volume prune", expectBlocked: true },
	{ command: "docker system prune -af", expectBlocked: true },
	{ command: "docker compose down -v", expectBlocked: true },
	{ command: "docker compose down", expectBlocked: false },
	{ command: "docker ps", expectBlocked: false },

	// ─── AWS ──────────────────────────────────────────────────────────────────
	{ command: "aws s3 rm s3://bucket/key", expectBlocked: true },
	{ command: "aws ec2 terminate-instances --instance-ids i-1", expectBlocked: true },
	{ command: "aws rds delete-db-instance --db-instance-id x", expectBlocked: true },
	{ command: "aws cloudformation delete-stack --stack-name x", expectBlocked: true },
	{ command: "aws s3 ls", expectBlocked: false },

	// ─── Wrappers + shell + find + xargs ──────────────────────────────────────
	{ command: "sudo rm /etc/hosts", expectBlocked: true },
	{ command: "sudo git reset --hard", expectBlocked: true },
	{ command: "env -i rm /etc/passwd", expectBlocked: true },
	{ command: "timeout 10 rm /etc/shadow", expectBlocked: true },
	{ command: 'bash -c "rm /etc/passwd"', expectBlocked: true },
	{ command: "sh -c 'git push --force'", expectBlocked: true },
	{ command: "find / -exec rm {} \\;", expectBlocked: true },
	{ command: "find . -exec rm {} \\;", expectBlocked: true, note: "{} is unresolvable (outside cwd)" },
	{ command: "find . -name x -delete", expectBlocked: false, note: "-delete not handled (inside cwd)" },
	{
		command: "echo foo | xargs rm",
		expectBlocked: true,
		note: "rm has no explicit target: real args arrive via stdin and can't be verified, so blocked conservatively",
	},
	{
		command: "find . -name '*.log' | xargs rm",
		expectBlocked: true,
		note: "same as above: xargs delegate has no explicit target",
	},
	{
		command: "cat ids.txt | xargs rm ./known-file.txt",
		expectBlocked: false,
		note: "explicit target given, resolvable and inside cwd -- still verified normally",
	},
	{
		command: "cat ids.txt | xargs rm /etc/passwd",
		expectBlocked: true,
		note: "explicit target given but outside cwd",
	},
	{ command: 'watch "rm /etc/passwd"', expectBlocked: true },

	// ─── Pipelines and concatenations ─────────────────────────────────────────
	{ command: "echo hi && git reset --hard", expectBlocked: true },
	{ command: "ls; rm /etc/passwd; echo done", expectBlocked: true },
	{ command: "git add . && git commit -m x", expectBlocked: true },
	{ command: "git log --oneline | head -5", expectBlocked: false },

	// ─── Sensitive files (check disabled by default: see config.ts) ───────────
	{ command: "cat .env", expectBlocked: false, note: "sensitive check disabled by default" },
	{ command: "grep KEY .env.local", expectBlocked: false, note: "sensitive check disabled by default" },
	{ command: "cat ~/.ssh/id_rsa", expectBlocked: false, note: "sensitive check disabled by default" },
	{ command: "head -n 1 config.yaml", expectBlocked: false, note: "sensitive check disabled (otherwise 'config' would match)" },
	{ command: "cat ./README.md", expectBlocked: false },

	// ─── Various safe commands ────────────────────────────────────────────────
	{ command: "pnpm test", expectBlocked: false },
	{ command: "ls -la", expectBlocked: false },
	{ command: "echo $HOME", expectBlocked: false },
	{ command: "mkdir -p dist/build", expectBlocked: false },
];

let passed = 0;
let failed = 0;

for (const c of cases) {
	const tokens = tokenize(c.command);
	const result = checkTokens(tokens, CWD);
	const blocked = result.dangerous;
	const ok = blocked === c.expectBlocked;
	const status = ok ? "PASS" : "FAIL";
	if (ok) passed++;
	else failed++;
	const tag = c.expectBlocked ? "block " : "allow";
	const note = c.note ? `  (${c.note})` : "";
	const reason = blocked && !ok ? `  -> ${result.reason}` : "";
	console.log(
		`${status}  [${tag}]  ${c.command}${note}${reason}`,
	);
}

console.log("");
console.log(`Result: ${passed} passed, ${failed} failed out of ${cases.length} cases.`);
if (failed > 0) {
	process.exit(1);
}
