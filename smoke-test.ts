/**
 * Smoke test standalone per tokenizer + checker.
 * Non dipende da pi: si può eseguire con:
 *   npx jiti smoke-test.ts
 *   npx tsx smoke-test.ts
 */

import { tokenize } from "./tokenizer";
import { checkTokens, isUnderProtected } from "./checker";

const CWD = "/Volumes/Disco_Dati/project/demo";

interface Case {
	command: string;
	expectBlocked: boolean;
	note?: string;
}

const cases: Case[] = [
	// Git distruttivo
	{ command: "git reset --hard", expectBlocked: true },
	{ command: "git reset --hard HEAD~3", expectBlocked: true },
	{ command: "git clean -fd", expectBlocked: true },
	{ command: "git clean -n", expectBlocked: false, note: "dry-run permesso" },
	{ command: "git push --force origin main", expectBlocked: true },
	{ command: "git push -f origin main", expectBlocked: true },
	{ command: "git push --force-with-lease", expectBlocked: true },
	{ command: "git push origin main", expectBlocked: false },
	{ command: "git push --delete origin feature", expectBlocked: true },
	{ command: "git branch -D old-feature", expectBlocked: true },
	{ command: "git branch -d old-feature", expectBlocked: false, note: "-d sicuro (safe)" },
	{ command: "git tag -d v1.0", expectBlocked: true },
	{ command: "git checkout -f .", expectBlocked: true },
	{ command: "git rebase main", expectBlocked: true },
	{ command: "git filter-branch --HEAD", expectBlocked: true },
	{ command: "git reflog expire --expire=now --all", expectBlocked: true },
	{ command: "git update-ref -d refs/heads/x", expectBlocked: true },
	// Git add/commit (flag abilitata)
	{ command: "git add .", expectBlocked: true },
	{ command: "git commit -m 'wip'", expectBlocked: true },
	// Flag globali git prima del subcommand (-C, -c, --git-dir, ...)
	{ command: "git -C /tmp/repo reset --hard", expectBlocked: true, note: "flag globale -C" },
	{ command: "git -C /tmp/repo commit -m x", expectBlocked: true, note: "flag globale -C" },
	{ command: "git -C /tmp/repo push --force origin main", expectBlocked: true, note: "flag globale -C" },
	{ command: "git --git-dir=/tmp/x reset --hard", expectBlocked: true, note: "flag globale con =" },
	{ command: "git --git-dir /tmp/x --work-tree /tmp/y push --force", expectBlocked: true, note: "flag globali separati" },
	{ command: "git --no-pager -C /tmp/x log", expectBlocked: false, note: "flag globali, subcommand sicuro" },
	{ command: "git -c core.editor=vim status", expectBlocked: false, note: "flag globale -c con subcommand sicuro" },
	// rm / path-sensitive
	{ command: "rm ./dist/build.js", expectBlocked: false, note: "dentro cwd" },
	{ command: "rm dist/old.log", expectBlocked: false, note: "dentro cwd" },
	{ command: "rm /etc/passwd", expectBlocked: true, note: "fuori cwd" },
	{ command: "rm ~/.ssh/id_rsa", expectBlocked: true, note: "fuori cwd" },
	{ command: "rm ../../secret.txt", expectBlocked: true, note: "fuori cwd" },
	{ command: "rm -rf /", expectBlocked: true, note: "fuori cwd" },
	{ command: "rmdir /tmp/old", expectBlocked: true },
	{ command: "shred ./secrets.txt", expectBlocked: false, note: "dentro cwd" },
	// Docker
	{ command: "docker rm abc", expectBlocked: true },
	{ command: "docker rmi img:latest", expectBlocked: true },
	{ command: "docker container rm abc", expectBlocked: true },
	{ command: "docker volume prune", expectBlocked: true },
	{ command: "docker system prune -af", expectBlocked: true },
	{ command: "docker compose down -v", expectBlocked: true },
	{ command: "docker compose down", expectBlocked: false },
	{ command: "docker ps", expectBlocked: false },
	// AWS
	{ command: "aws s3 rm s3://bucket/key", expectBlocked: true },
	{ command: "aws ec2 terminate-instances --instance-ids i-1", expectBlocked: true },
	{ command: "aws rds delete-db-instance --db-instance-id x", expectBlocked: true },
	{ command: "aws cloudformation delete-stack --stack-name x", expectBlocked: true },
	{ command: "aws s3 ls", expectBlocked: false },
	// Wrapper + shell + find + xargs
	{ command: "sudo rm /etc/hosts", expectBlocked: true },
	{ command: "sudo git reset --hard", expectBlocked: true },
	{ command: "env -i rm /etc/passwd", expectBlocked: true },
	{ command: "timeout 10 rm /etc/shadow", expectBlocked: true },
	{ command: 'bash -c "rm /etc/passwd"', expectBlocked: true },
	{ command: "sh -c 'git push --force'", expectBlocked: true },
	{ command: "find / -exec rm {} \\;", expectBlocked: true },
	{ command: "find . -exec rm {} \\;", expectBlocked: true, note: "{} è fuori cwd (unresolvable)" },
	{ command: "find . -name x -delete", expectBlocked: false, note: "-delete non gestito (dentro cwd)" },
	{
		command: "echo foo | xargs rm",
		expectBlocked: false,
		note: "limiti dell'analisi statica: gli argomenti di rm arrivano via stdin, non sono visibili come argomenti (comportamento coerente col plugin Claude)",
	},
	{ command: 'watch "rm /etc/passwd"', expectBlocked: true },
	// Pipeline e concatenazioni
	{ command: "echo hi && git reset --hard", expectBlocked: true },
	{ command: "ls; rm /etc/passwd; echo done", expectBlocked: true },
	{ command: "git add . && git commit -m x", expectBlocked: true },
	{ command: "git log --oneline | head -5", expectBlocked: false },
	// File sensibili (check disattivato di default: vedi config.ts)
	{ command: "cat .env", expectBlocked: false, note: "check sensibili disattivato di default" },
	{ command: "grep KEY .env.local", expectBlocked: false, note: "check sensibili disattivato di default" },
	{ command: "cat ~/.ssh/id_rsa", expectBlocked: false, note: "check sensibili disattivato di default" },
	{ command: "head -n 1 config.yaml", expectBlocked: false, note: "check sensibili disattivato (altrimenti 'config' matcherebbe)" },
	{ command: "cat ./README.md", expectBlocked: false },
	// Comandi sicuri vari
	{ command: "pnpm test", expectBlocked: false },
	{ command: "ls -la", expectBlocked: false },
	{ command: "echo $HOME", expectBlocked: false },
	{ command: "mkdir -p dist/build", expectBlocked: false },
	// Write-protection su docs/specs/guards (dentro cwd)
	{ command: "echo x > docs/specs/guards/g.sh", expectBlocked: true, note: "redirect su path protetto" },
	{ command: "echo x >> docs/specs/guards/g.sh", expectBlocked: true, note: "append su path protetto" },
	{ command: "cp a docs/specs/guards/g.sh", expectBlocked: true, note: "cp dest protetto" },
	{ command: "mv a docs/specs/guards/", expectBlocked: true, note: "mv dest protetto" },
	{ command: "chmod +x docs/specs/guards/g.sh", expectBlocked: true, note: "chmod su protetto" },
	{ command: "tee docs/specs/guards/g.sh", expectBlocked: true, note: "tee su protetto" },
	{ command: "rm docs/specs/guards/g.sh", expectBlocked: true, note: "rm su protetto (path-sensitive)" },
	{ command: "rm ./docs/specs/guards/g.sh", expectBlocked: true, note: "rm con ./ prefisso" },
	{ command: "ls docs/specs/guards", expectBlocked: false, note: "lettura permessa" },
	{ command: "cat docs/specs/guards/g.sh", expectBlocked: false, note: "lettura permessa" },
	{ command: "bash docs/specs/guards/g.sh", expectBlocked: false, note: "esecuzione permessa" },
	{ command: "echo x > dist/build.js", expectBlocked: false, note: "redirect fuori dai protetti" },
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

// ── isUnderProtected: casistica path (tool write/edit/apply_patch) ──
const protectedCases: { path: string; expect: boolean; note?: string }[] = [
	{ path: "docs/specs/guards/g.sh", expect: true },
	{ path: "./docs/specs/guards/g.sh", expect: true },
	{ path: "docs/specs/guards", expect: true, note: "la directory stessa" },
	{ path: "docs/specs/guards/sub/x.sh", expect: true, note: "sottopath" },
	{ path: "$REPO/docs/specs/guards/x.sh", expect: true, note: "variabile + prefisso letterale" },
	{ path: "libs/server/x.ts", expect: false, note: "non protetto" },
	{ path: "docs/specs/altro.md", expect: false, note: "sorella non protetta" },
	{ path: "dist/build.js", expect: false },
];

console.log("");
for (const c of protectedCases) {
	const got = isUnderProtected(c.path, CWD);
	const ok = got === c.expect;
	const status = ok ? "PASS" : "FAIL";
	if (ok) passed++;
	else failed++;
	const note = c.note ? `  (${c.note})` : "";
	console.log(`${status}  [protected]  ${c.path} -> ${got}${note}`);
}

console.log("");

console.log("");
console.log(`Risultato: ${passed} passati, ${failed} falliti su ${cases.length} casi.`);
if (failed > 0) {
	process.exit(1);
}
