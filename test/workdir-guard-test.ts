import {
	checkCommandWorkdir,
	checkPathInsideWorkdir,
	checkToolInputWorkdir,
} from "../src/rules/workdir-guard";
import { type CheckResult } from "../src/rules/types";

const CWD = "/home/user/projects/demo";

function run(command: string): CheckResult {
	return checkCommandWorkdir(command, CWD);
}

let passed = 0;
let failed = 0;

function case_(command: string, expectBlocked: boolean, note?: string): void {
	const result = run(command);
	const blocked = result.dangerous;
	const ok = blocked === expectBlocked;
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "PASS" : "FAIL"} ${command} ${note ? `- ${note}` : ""}`);
	if (!ok) {
		console.error(`  expected blocked=${expectBlocked}, got blocked=${blocked} reason=${result.reason}`);
	}
}

case_("cat ./README.md", false, "relative path inside cwd");
case_("cat src/index.ts", false, "relative path inside cwd");
case_("ls .", false, "dot is inside cwd");
case_("ls ./subdir", false, "subdir inside cwd");
case_("cd ./subdir && cat file.txt", false, "cd inside the boundary");

case_("cat /etc/passwd", true, "absolute path outside cwd");
case_("rm /tmp/../etc/passwd", true, "path traversal outside cwd");
case_("cat ../../secret.txt", true, "parent dir traversal outside cwd");
case_("cat ~/document.txt", true, "home dir outside cwd");
case_("cp /var/log/syslog ./", true, "absolute source outside cwd");
case_("cd /etc && cat passwd", true, "cd escapes the boundary");
case_("cat \"$HOME/secret\"", true, "variable path cannot be verified");

case_("cat /tmp/file.txt", false, "tmp path allowed");
case_("cp ./file.txt /tmp/", false, "tmp destination allowed");
case_("rm /tmp/temp.log", false, "tmp removal allowed");
case_("mkdir /tmp/newdir", false, "tmp mkdir allowed");
case_("rm -rf /tmp", true, "the temp root itself is not a temp file");
case_("cd /tmp", false, "cd into the temp root is allowed");
case_("cd /private/tmp && ls", false, "cd into the canonical temp root is allowed");
case_("pushd /tmp", false, "pushd into the temp root is allowed");
case_("ls /tmp", false, "listing the temp root is allowed");
case_("cd /tmp && cat a.txt", false, "relative path after cd /tmp stays in temp");
case_("cd /tmp && rm -rf foo", false, "temp file removal after cd /tmp");
case_("cd /tmp && cat ../etc/passwd", true, "leaving temp after cd /tmp is blocked");
case_("cd /tmp && cd .. && ls", true, "cd out of temp is blocked");
case_("chmod 777 /tmp", true, "changing the temp root itself is blocked");
case_("mv /tmp ./x", true, "moving the temp root away is blocked");
case_("mv /tmp/a.txt ./a.txt", false, "moving a temp file into the workdir is allowed");
case_("mv ~/.agents/skills/x.md ./", true, "moving a skill out removes it and is blocked");

case_(
	"grep -rn \"pattern\" docs/ .pi/ 2>/dev/null | head -30",
	false,
	"stderr redirected to the null device",
);
case_("echo output > /dev/null", false, "stdout redirected to the null device");
case_("echo output >> /dev/null", false, "appended stdout redirected to the null device");
case_("cat /dev/null", true, "direct null device reads remain blocked");
case_("rm /dev/null", true, "destructive null device access remains blocked");
case_("cp ./file.txt /dev/null", true, "ordinary writes to the null device remain blocked");
case_("echo output > /dev/stdout", true, "other device paths remain blocked");
case_("echo output > /etc/passwd", true, "redirects to other outside paths remain blocked");
case_(
	"(npx vite --port 5199 >/tmp/vite-smoke.log 2>&1 &) && sleep 2 && curl -s http://localhost:5199/ | grep -o '<title>[^<]*</title>' && curl -s -o /dev/null -w '%{http_code}\\n' http://localhost:5199/src/main.js && pkill -f \"vite --port 5199\"",
	false,
	"curl output option discarded to the null device (issue #37)",
);
case_("curl -s -o /dev/null http://localhost:5199/", false, "curl -o /dev/null allowed");
case_("curl --output /dev/null http://localhost:5199/", false, "curl --output /dev/null allowed");
case_("wget -q -O /dev/null http://localhost:5199/", false, "wget -O /dev/null allowed");
case_("curl -o /etc/passwd http://localhost:5199/", true, "output option to other outside paths remains blocked");
case_("curl -o /dev/stdout http://localhost:5199/", true, "output option to other devices remains blocked");
case_("rm -o /dev/null", true, "destructive command operand stays blocked even after -o");
case_("cp -o ./file.txt /dev/null", true, "copy destination stays blocked even after -o");
case_("curl --output=/etc/passwd https://example.com", true, "attached output option value outside cwd (issue #39)");
case_("wget --output-document=~/.bashrc https://example.com", true, "attached output-document value in home dir");
case_("tar --file=/etc/shadow -t", true, "attached option value outside cwd");
case_("node build.js --config=../../secret.json", true, "attached relative option value escaping cwd");
case_("curl --output=/dev/null https://example.com", false, "attached output value to the null device");
case_("curl --output=./out.html https://example.com", false, "attached output value inside cwd");
case_("tar --file=/tmp/a.tar -t", false, "attached option value in temp dir");
case_("node build.js --base-url=https://example.com/a/b", false, "URL option values are not paths");
case_("git log --format=%h/%s", false, "format strings are free text");
case_("gh pr create --title=fix/api --body=/etc/notes", false, "title and body are free text");
case_("tar --exclude=/etc/x --file=./a.tar -t", true, "other attached absolute values outside cwd stay blocked");

case_(
	"sed -n '/ThreadsLista\\|ThreadRiga\\|threads /p' \"Hotello - Conversazioni.dc.html\" | head -5",
	false,
	"a slash-delimited sed address is a script, not a path",
);
case_(
	"cd .claude-design && sed -n '/pattern/p' \"Hotello - Conversazioni.dc.html\" | head -5",
	false,
	"a sed address script is allowed after changing to a subdirectory",
);
case_("sed -n '/pattern/p' src/file.txt", false, "a sed address script is allowed");
case_("sed -n -e '/pattern/p' src/file.txt", false, "a sed expression script is allowed");
case_("sed -n '/pattern/p' /etc/passwd", true, "a sed input outside the workdir remains blocked");
case_("sed -f /etc/script.sed src/file.txt", true, "a sed script file outside the workdir remains blocked");
case_("sed --file=/etc/script.sed src/file.txt", true, "an attached sed script file path remains blocked");
case_("sed -n '/pattern/w /etc/passwd' src/file.txt", true, "a sed script that writes outside remains blocked");
case_("sed --expression='/pattern/w /etc/passwd' src/file.txt", true, "an attached unsafe sed expression remains blocked");
case_("grep sed '/pattern/p'", true, "sed is only classified as a command at command start");

// Issue #46: program and pattern operands of text tools and interpreters are not paths.
case_("awk '/^<<<<<<</,/^>>>>>>>/' js/a.js", false, "awk range program is not a path");
case_("awk '/foo/' js/a.js", false, "awk regex program is not a path");
case_("awk -F / '{print $1}' js/a.js", false, "awk -F separator is a pattern");
case_("awk -F/ '{print $1}' js/a.js", false, "awk attached -F separator");
case_("sed -n '/start/,/end/p' js/a.js", false, "sed range address followed by a command");
case_("sed -n '/re/,+3p' js/a.js", false, "sed range with +N");
case_("sed -n '10,/end/p' js/a.js", false, "sed range from a line number");
case_("sed -n '\\%/usr%p' js/a.js", false, "sed custom-delimiter address");
case_("sed -n -e '/a/,/b/p' -e '/c/d' js/a.js", false, "multiple sed -e scripts");
case_("grep '/api/' js/a.js", false, "grep pattern is not a path");
case_("grep -e '/x/' js/a.js", false, "grep -e pattern is not a path");
case_("grep --regexp=/x/ js/a.js", false, "grep attached --regexp pattern");
case_("grep -rn '/api/' src", false, "grep pattern after a short-option cluster");
case_("rg '/api/' js", false, "rg pattern is not a path");
case_("rg -e '/a/' -e '/b/' src", false, "multiple rg -e patterns");
case_("perl -ne 'print if /foo/' js/a.js", false, "perl -ne program is not a path");
case_("node -e \"const s=x.replace(/d.order === 3/,'y'); console.log(s)\"", false, "node -e regex literal is not a path");
case_("node -e \"console.log('a/b'.replace(/a\\\\/b/, 'c'))\"", false, "node -e relative string literal");
case_("python3 -c \"import re; print(re.sub(r'/x/', '', 'a'))\"", false, "python re.sub pattern is not a path");
case_("awk '/x/' /etc/passwd", true, "awk input file outside remains blocked");
case_("grep x /etc/hosts", true, "grep input file outside remains blocked");
case_("rg x /etc", true, "rg search path outside remains blocked");
case_("awk -f /etc/p.awk js/a.js", true, "awk program file outside remains blocked");
case_("grep -f /etc/patterns js/a.js", true, "grep pattern file outside remains blocked");
case_("rg --file /etc/patterns js", true, "rg pattern file outside remains blocked");
case_("sed -n '/start/,/end/p' /etc/passwd", true, "sed input outside remains blocked");
case_("sed -n '/a/,/b/w /etc/x' js/a.js", true, "sed range that writes outside remains blocked");
case_("awk '{print > \"/etc/x\"}' js/a.js", true, "awk string literal path outside is checked");
case_("awk 'BEGIN{system(\"cat /etc/passwd\")}'", true, "awk system() command line is checked");
case_("node -e \"require('fs').readFileSync('/etc/passwd')\"", true, "node string literal path outside is checked");
case_("python3 -c \"open('/etc/passwd').read()\"", true, "python string literal path outside is checked");
case_("ruby -e 'File.read(\"/etc/passwd\")'", true, "ruby string literal path outside is checked");
case_("perl -ne 'print' /etc/passwd", true, "perl input file outside remains blocked");
case_("python3 /etc/x.py", true, "interpreter script file outside remains blocked");
case_("node -e \"s.replace(/'/g, 'x'); fs.readFileSync('/etc/passwd')\"", true, "unparseable program falls back to token analysis");

case_(
	"git add -A && git commit -m \"feat(conversazioni): lista /conversazioni su viewport < 768px\"",
	false,
	"a commit message containing path-like words is free text",
);
case_(
	"git commit -m 'fix: mention of /etc/passwd in docs'",
	false,
	"an absolute-looking path inside a commit message is not a target",
);
case_(
	'git commit --message="fix path /usr/bin mention"',
	false,
	"an attached --message value is free text",
);
case_(
	"git commit -am \"chore: full /width layout\"",
	false,
	"combined short flags ending in m take message text",
);
case_(
	"git tag -a v1.0 -m 'release /build notes' && git commit -m 'second /msg'",
	false,
	"message text is free text across chained commands",
);
case_(
	"git notes add -m 'note about /conversazioni'",
	false,
	"git notes messages are free text",
);
case_(
	"git commit -F /etc/passwd",
	true,
	"a commit message file outside the workdir remains blocked",
);
case_(
	"git add /etc/passwd",
	true,
	"git path arguments outside the workdir remain blocked",
);
case_(
	"git commit -m \"msg\" --template=/etc/template",
	true,
	"a commit template outside the workdir remains blocked",
);

case_("cat ~/.agents/skills/graphify/SKILL.md", false, "reading an installed skill is allowed");
case_("cat ~/.pi/skills/custom/SKILL.md", false, "reading a pi skill is allowed");
case_("ls ~/.agents/skills", false, "listing the skills directory is allowed");
case_("echo x > ~/.agents/skills/graphify/SKILL.md", true, "writing a skill is blocked");
case_("tee ~/.pi/skills/custom/SKILL.md", true, "teeing a skill is blocked");
case_("cp /tmp/x ~/.agents/skills/x.md", true, "copying into a skill directory is blocked");
case_("cp ~/.agents/skills/x.md /tmp/", false, "copying a skill out is allowed");
case_("chmod +x ~/.agents/skills/x.md", true, "changing skill permissions is blocked");
case_("rm -rf ~/.agents/skills", true, "removing a skill directory is blocked");
case_("rm ~/.agents/skills/x.md", true, "removing a skill is blocked");
case_("bash -c \"cat /etc/passwd\"", true, "nested shell command is analyzed");
case_("eval \"cat /etc/passwd\"", true, "quoted command line is analyzed");
case_("echo hello", false, "no path");
case_("git status", false, "no path");
case_("npm install", false, "no path");

function checkTool(name: string, expected: boolean, actual: CheckResult): void {
	if (expected === actual.dangerous) passed++;
	else {
		failed++;
		console.error(`  FAIL ${name}: expected blocked=${expected}, got ${actual.dangerous} reason=${actual.reason}`);
	}
}

checkTool(
	"write inside cwd",
	false,
	checkToolInputWorkdir("write", { path: "src/a.ts" }, () => [], CWD),
);
checkTool(
	"write outside cwd",
	true,
	checkToolInputWorkdir("write", { path: "/etc/passwd" }, () => [], CWD),
);
checkTool(
	"write to temp dir",
	false,
	checkToolInputWorkdir("write", { path: "/tmp/x.txt" }, () => [], CWD),
);
checkTool(
	"write to null device",
	true,
	checkToolInputWorkdir("write", { path: "/dev/null" }, () => [], CWD),
);
checkTool(
	"edit outside cwd",
	true,
	checkToolInputWorkdir("edit", { path: "../outside.ts" }, () => [], CWD),
);
checkTool(
	"apply_patch outside cwd",
	true,
	checkToolInputWorkdir("apply_patch", { input: "patch" }, () => ["/etc/passwd"], CWD),
);
checkTool(
	"read outside cwd",
	true,
	checkToolInputWorkdir("read", {}, () => [], CWD, ["/etc/passwd"]),
);
checkTool(
	"read inside cwd",
	false,
	checkToolInputWorkdir("read", {}, () => [], CWD, ["src/index.ts"]),
);
checkTool(
	"read a skill file",
	false,
	checkToolInputWorkdir("read", {}, () => [], CWD, ["~/.agents/skills/graphify/SKILL.md"]),
);
checkTool(
	"read a pi skill file",
	false,
	checkToolInputWorkdir("read", {}, () => [], CWD, ["~/.pi/skills/custom/SKILL.md"]),
);
checkTool(
	"write a skill file",
	true,
	checkToolInputWorkdir("write", { path: "~/.agents/skills/graphify/SKILL.md" }, () => [], CWD),
);
checkTool(
	"edit a skill file",
	true,
	checkToolInputWorkdir("edit", { path: "~/.pi/skills/custom/SKILL.md" }, () => [], CWD),
);
checkTool(
	"apply_patch a skill file",
	true,
	checkToolInputWorkdir("apply_patch", { input: "patch" }, () => ["~/.agents/skills/x.md"], CWD),
);

if (checkPathInsideWorkdir("src/file.ts", CWD, CWD).dangerous) {
	failed++;
	console.error("FAIL checkPathInsideWorkdir relative inside");
} else passed++;

if (!checkToolInputWorkdir("write", { path: "/tmp" }, () => [], CWD).dangerous) {
	failed++;
	console.error("FAIL write tool on the temp root must be blocked");
} else {
	passed++;
	console.log("PASS write tool on the temp root is blocked");
}

if (checkPathInsideWorkdir("/tmp/x", CWD, CWD).dangerous) {
	failed++;
	console.error("FAIL checkPathInsideWorkdir tmp allowed");
} else passed++;

if (checkPathInsideWorkdir("/etc/passwd", CWD, CWD).dangerous) {
	passed++;
} else {
	failed++;
	console.error("FAIL checkPathInsideWorkdir outside blocked");
}

// Issue #41: API endpoint arguments are not filesystem paths.
case_("sonar api get \"/api/ce/activity?project=x\"", false, "sonar api endpoint");
case_("EP=\"/api/ce/activity?project=x\"; sonar api get \"$EP\"", false, "endpoint via variable");
case_("gh api /repos/o/r/pulls", false, "gh api endpoint");
case_("gh api -X GET --paginate /repos/o/r/pulls -q '.[].title'", false, "gh api endpoint after flags");
case_("gh api /repos/o/r/pulls | jq '.[0]'", false, "gh api endpoint piped");
case_("gh api \"/repos/$OWNER/r/issues\"", false, "gh api endpoint with variable");
case_("http GET /api/health", false, "httpie method + endpoint");
case_("xh --timeout 5 localhost:3000/api/health", false, "xh endpoint after value flag");
case_("curl http://localhost:3000/api/health", false, "curl URL");
case_("gh api /repos/x --input /etc/passwd", true, "gh api --input outside");
case_("gh api /repos/x --input=/etc/passwd", true, "gh api --input= outside");
case_("gh api /repos/x -F body=@/etc/passwd", true, "gh api -F @file outside");
case_("gh api /repos/x -F body=@./notes.md", false, "gh api -F @file inside");
case_("http POST /api/upload file@/etc/passwd", true, "httpie file item outside");
case_("http POST /api/upload data=@/etc/passwd", true, "httpie embedded file outside");
case_("http POST /api/upload name=value", false, "httpie data item");
case_("http --cert /etc/ssl/key.pem GET /api/x", true, "httpie cert file outside");
case_("EP=\"/etc/passwd\"; gh api /x; cat \"$EP\"", true, "assignment not feeding an endpoint still checked");
case_("gh api \"/repos/$(cat /etc/passwd)\"", true, "command substitution in endpoint");
case_("sonar api get --data /etc/passwd /api/x", true, "sonar non-strict form not exempted");
case_("gh pr view /etc/passwd", true, "other gh subcommands unaffected");

if (failed > 0) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
} else {
	console.log(`\nAll ${passed} test(s) passed`);
}
