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
// Issue #46 review findings.
case_("rg --files /etc", true, "rg --files takes no pattern: the path outside is checked");
case_("rg --files ../other", true, "rg --files parent path outside is checked");
case_("rg --type-list /etc", true, "rg --type-list takes no pattern");
case_("rg --files src", false, "rg --files path inside is allowed");
case_("ag -g foo /etc", true, "ag -g supplies the pattern: the path outside is checked");
case_("ag -g foo src", false, "ag -g path inside is allowed");
case_("perl -e 'unlink q(/etc/x)'", true, "perl q() literal path outside is checked");
case_("perl -e 'unlink qq{/etc/x}'", true, "perl qq{} literal path outside is checked");
case_("perl -e 'print q(hello)'", false, "perl q() literal without a path");
case_("ruby -e 'IO.read(%q(/etc/passwd))'", true, "ruby %q() literal path outside is checked");
case_("ruby -e 'IO.read(%(/etc/passwd))'", true, "ruby %() literal path outside is checked");
case_("ruby -e 'puts %w[a b]'", false, "ruby %w[] literal without a path");
case_("node -pe \"require('fs').readFileSync('/etc/passwd')\"", true, "node -pe program literal is checked");
case_("node -ep \"require('fs').readFileSync('/etc/passwd')\"", true, "node -ep program literal is checked");
case_("node -p \"require('fs').readFileSync('/etc/passwd')\"", true, "node -p program literal is checked");
case_("node -pe \"'a'.replace(/x/,'y')\"", false, "node -pe regex literal is not a path");
case_("deno eval --ext ts \"Deno.readTextFileSync('/etc/passwd')\"", true, "deno eval --ext value is skipped, code is checked");
case_("deno eval --ext ts \"'a'.replace(/x/,'y')\"", false, "deno eval --ext code regex is not a path");
case_("deno eval -c /etc/deno.json \"1\"", true, "deno eval -c config path outside is checked");
case_("awk '{n=split($0,a,\"/\")}' js/a.js", false, "awk split separator literal is not a path");
case_("awk 'BEGIN{FS=\"/\"}'", false, "awk FS separator literal is not a path");
case_("python3 -c \"print('a/b'.split('/'))\"", false, "python separator literal is not a path");
case_("ruby -e 'puts \"/\"'", false, "ruby slash literal is not a path");
case_("perl -e 'print join(\"/\",1,2)'", false, "perl join separator literal is not a path");
case_("awk 'BEGIN{print \"/etc/passwd\"}'", true, "awk real path literal is still checked");
case_("perl -nle 'print if /x/' js/a.js", false, "perl -nle program is not a path");
case_("perl -lne 'print if /x/' js/a.js", false, "perl -lne program is not a path");
case_("perl -lane 'print if /x/' js/a.js", false, "perl -lane program is not a path");
case_("perl -wle 'print if /x/' js/a.js", false, "perl -wle program is not a path");
case_("perl -nle 'print if /x/' /etc/passwd", true, "perl -nle input file outside remains blocked");
case_("perl -l -e 'open(F,\"/etc/x\")'", true, "perl -l -e program literal is checked");
case_("rg --color never '/api/'", false, "rg --color value is skipped before the pattern");
case_("rg --color never x /etc", true, "rg --color search path outside remains blocked");
case_("grep -r --include='*.ts' '/x/' .", false, "grep --include= attached quoted value split by the tokenizer");
case_("grep -rn --include='*.ts' '/api/users' src", false, "attached quoted --include value, pattern allowed");
case_("grep --exclude-dir='node_modules' '/api/' f", false, "attached quoted --exclude-dir value");
case_("rg --glob='*.ts' '/api/' src", false, "attached quoted rg --glob value");
case_("rg --max-count='5' '/api/' src", false, "attached quoted rg --max-count value");
case_("rg --color='never' '/api/' src", false, "attached quoted rg --color value");
case_("rg --iglob='*.ts' '/x/' .", false, "attached quoted rg --iglob value");
case_(`grep --include="*.ts" '/x/' .`, false, "attached double-quoted value");
case_(`rg --color="" '/api/' src`, false, "attached empty value");
case_("grep -r --include='*.ts' x /etc", true, "attached quoted value, search path outside still blocked");
case_("grep -r --include='*.ts' '/x/' /etc", true, "attached quoted value, second operand outside still blocked");
case_("cd . && grep -r --include='*.ts' '/x/' .", false, "attached value after a separator");
case_("grep -r --include= '*.ts' '/x/' .", true, "separated --include= stays ambiguous");
case_("grep -r --include='*.ts' x /etc", true, "grep --include= search path outside remains blocked");
case_("grep --exclude-from= /etc/x y js/a.js", true, "grep empty --exclude-from= value is still checked");
case_("grep --regexp= /etc/passwd", true, "grep empty --regexp= next token is still checked");
case_("deno eval --import-map='/etc/x.json' 'x'", true, "deno eval split --import-map= value is checked");
case_("deno eval --config='/etc/x.json' 'x'", true, "deno eval split --config= value is checked");
case_("deno eval --lock /etc/lock 'x'", true, "deno eval --lock value is checked");
case_("deno eval --env-file /etc/x 'Deno.readTextFileSync(\"/etc/passwd\")'", true, "deno eval --env-file value is checked");
case_("deno eval --tsconfig /etc/x 'x'", true, "deno eval --tsconfig value is checked");
case_("deno eval --unknown-opt /etc/x 'x'", true, "deno eval unknown option: no program classified, generic analysis");
case_("deno eval --ext ts \"console.log(/a/.test('b'))\"", false, "deno eval --ext code regex is not a path");
case_("node -e 'var a=\"<script src=\\\"js/a.js\\\"></script>\";'", false, "escaped quotes inside a JS literal: markup is not a command line (#55)");
case_("node -e 'var a=\"</script>\"'", false, "closing tag literal (#55)");
case_("node -e 'var a=\"x</script>\"'", false, "closing tag after text (#55)");
case_("node -e 'console.log(\"</div>\")'", false, "closing div literal (#55)");
case_("node -e 'var a=\"<script src=\\\"/etc/passwd\\\"></script>\";'", true, "markup with an absolute path word is still checked (#55)");
case_("node -e 'var a=\"<x> cat /etc/passwd\"'", true, "markup-like literal with outside path stays blocked (#55)");
case_("node -e 'var a=\"<a> cat >/etc/passwd\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<a> cat </etc/passwd\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat 2>/etc/passwd\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat x>>/etc/passwd\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<a> cat x>/etc/passwd</a>\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat \\\"/etc/passwd\\\"\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat \\\"/etc/passwd\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat (/etc/passwd)\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> ls \\\\/etc\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> ls \\\"\\\"/etc\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat x/../../x\"'", true, "markup-like literal bypass stays blocked (#55)");
case_("node -e 'var a=\"<b> cat ./../../../../etc/passwd\"'", true, "markup-like literal bypass stays blocked (#55)");
{
	const started = Date.now();
	const r = run(`node -e 'var a="<a${" ".repeat(100000)}"'`);
	const ms = Date.now() - started;
	const ok = ms < 200 && !r.dangerous;
	if (ok) passed++;
	else failed++;
	console.log(`${ok ? "PASS" : "FAIL"} unterminated tag followed by 100k spaces is linear - ${ms} ms (#55)`);
}
case_("perl -e 'unlink \"/\"'", true, "slash literal passed to unlink is checked");
case_("python3 -c \"os.listdir('/ ')\"", true, "slash literal passed to os.listdir is checked");
case_("node -e \"require('fs').rmSync('/')\"", true, "slash literal passed to rmSync is checked");
case_("ruby -e 'FileUtils.rm_rf(\"/\")'", true, "slash literal passed to FileUtils.rm_rf is checked");

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

// Issue #53: node/deno/--opt= leftovers.
const READ_PASSWD = `require("fs").readFileSync("/etc/passwd")`;
case_(`node --eval='${READ_PASSWD}'`, true, "node --eval= split program is scanned");
case_(`node --print='${READ_PASSWD}'`, true, "node --print= split program is scanned");
case_(`node --eval=${READ_PASSWD.replace(/ /g, "")}`, true, "node --eval=CODE attached is scanned");
case_(`node -p -e '${READ_PASSWD}'`, true, "node -p -e program is scanned");
case_(`node --print -e '${READ_PASSWD}'`, true, "node --print -e program is scanned");
case_(`node --max-old-space-size 100 -e '${READ_PASSWD}'`, true, "node value option before -e");
case_(`node --stack-size 1 -pe '${READ_PASSWD}'`, true, "node value option before -pe");
case_(`node -r ./x.js -e '${READ_PASSWD}'`, true, "node -r value before -e");
case_(`deno eval --check 'Deno.readTextFileSync("/etc/passwd")'`, true, "deno eval --check program is scanned");
case_(`deno eval -q --no-remote 'Deno.readTextFileSync("/etc/passwd")'`, true, "deno eval booleans before program");
case_(`deno eval --reload 'Deno.readTextFileSync("/etc/passwd")'`, true, "deno eval --reload program is scanned");
case_("rg --color= foo /etc", true, "empty --opt= does not swallow the pattern");
case_("grep --exclude-dir= foo /etc", true, "empty --exclude-dir= does not swallow the pattern");
case_("rg --color= --hidden foo /etc", true, "empty --opt= before an option");
case_("rg --color=never foo /etc", true, "attached value, path still blocked");
case_(`node --eval='x.replace(/a/,"b")'`, false, "node --eval= split regex literal allowed");
case_(`node --max-old-space-size 100 -e "x.replace(/a/,'b')"`, false, "node value option, regex program allowed");
case_("node -p -e 'x.replace(/a/,1)'", false, "node -p -e regex program allowed");
case_("deno eval --check 'x.replace(/a/,1)'", false, "deno eval --check regex program allowed");
case_("rg --color=never '/api/' src", false, "attached empty-free value, pattern allowed");
case_("rg --color= '' /etc", true, "empty --opt= then empty token");
case_("rg --color= '*' /etc/x", true, "empty --opt= then glob token");
case_("grep --exclude-dir= '' /etc/x", true, "empty --exclude-dir= then empty token");
case_("grep --exclude-dir= 'a,b' /etc/x", true, "empty --opt= then comma list");
// Shell expansion in program operands is analysed generically (quote-aware).
case_(`node --eval="$(cat /etc/passwd)"`, true, "node --eval= double-quoted substitution");
case_(`node --print="$(cat /etc/passwd)"`, true, "node --print= double-quoted substitution");
case_("node --eval=\"${X:-/etc/passwd}\"", true, "node --eval= double-quoted parameter expansion");
case_(`node --max-old-space-size 100 --eval "$(cat /etc/passwd)"`, true, "value option then --eval substitution");
case_(`node -e "$(cat /etc/passwd)"`, true, "node -e double-quoted substitution");
case_("node -e \"`cat /etc/passwd`\"", true, "node -e double-quoted backticks");
case_(`python3 -c "$(cat /etc/passwd)"`, true, "python -c double-quoted substitution");
case_("node -e 'console.log(`${x}`)'", false, "single-quoted JS template literal stays allowed");
case_("node --eval='console.log(`${x}`)'", false, "single-quoted --eval= template literal stays allowed");
// deno optional-value options.
case_("deno eval --check /etc/passwd", true, "optional-value option followed by a path");
case_(`deno eval --check -- 'Deno.readTextFileSync("/etc/passwd")'`, true, "program after -- is scanned");
case_(`deno eval -q -- 'Deno.readTextFileSync("/etc/passwd")'`, true, "program after -- is scanned (boolean option)");
case_("deno eval --reload ../../x", true, "optional-value option followed by a relative escape");
case_("deno eval --check -- 'x.replace(/a/,1)'", false, "regex program after -- allowed");
case_("rg --color= foo src", false, "empty --opt= with relative path allowed");

// Issue #59: an attached quoted value followed directly by more text is one shell word.
case_("grep --exclude-from=''/etc/x foo", true, "attached empty quote + unquoted path is one value");
case_("rg --ignore-file=''/etc/x foo", true, "attached empty single quote + path");
case_(`rg --ignore-file=""/etc/x foo`, true, "attached empty double quote + path");
case_(`rg --ignore-file=''"/etc/x" foo`, true, "attached empty quote + quoted path");
case_("rg --pre=''/etc/x foo", true, "attached empty quote + preprocessor path");
case_("rg --ignore-file='/e'tc/x foo", true, "path split across quoted and unquoted segments");
case_(`node --eval='fs.readFileSync("'/etc/passwd'")'`, true, "program spliced from quoted segments is scanned whole");
case_("rg --glob='*'.ts '/api/' src", false, "joined attached glob value, pattern still allowed");
case_("rg --ignore-file=''.ignore foo src", false, "joined attached relative value inside cwd");

// Issue #60: $TMPDIR (the orchestrator's in-worktree scratch dir) is resolved from the environment.
{
	const savedTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = `${CWD}/.scratch`;
	case_(`python3 lint.py > "$TMPDIR/lint.out" 2>&1`, false, "redirect into $TMPDIR inside cwd");
	case_(`cat > "\${TMPDIR}/search.js" <<'EOF'\nconsole.log(1)\nEOF`, false, "${TMPDIR} heredoc target");
	case_(`ls "$TMPDIR"/*.pid`, false, "quoted $TMPDIR followed by a glob is one word");
	case_(`for f in "$TMPDIR"/*.pid; do kill $(cat "$f"); done`, false, "loop over $TMPDIR glob");
	case_(`cd "$TMPDIR" && ls && cat a.txt`, false, "cd into $TMPDIR");
	case_(`TMPDIR=/etc cat "$TMPDIR/passwd"`, true, "TMPDIR assigned in the command is not trusted");
	case_(`export TMPDIR=/etc; cat "$TMPDIR/x"`, true, "TMPDIR exported in the command is not trusted");
	case_(`cat "\${TMPDIR:-/etc}/x"`, true, "parameter expansion with a default stays unresolvable");
	case_(`cat "$HOME/x"`, true, "other variables stay unresolvable");
	case_(`cat "$TMPDIR/../../../../etc/passwd"`, true, "expanded path escaping the cwd is blocked");
	case_(`cd "$TMPDIR" && cat ../../../../../etc/passwd`, true, "relative escape after cd $TMPDIR is blocked");
	case_(`ls "$X"/*.pid`, true, "unresolvable quoted variable + glob is not read as a glob from /");
	process.env.TMPDIR = "/home/user/other";
	case_(`cat "$TMPDIR/x"`, true, "TMPDIR outside cwd and temp is blocked");
	delete process.env.TMPDIR;
	case_(`cat "$TMPDIR/x"`, true, "unset TMPDIR is blocked");
	if (savedTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = savedTmpdir;
}
// Issue #61: a literal after a concatenation operator is the tail of a runtime path.
case_(`python3 -c "j=json.load(open('.agent-evidence/a/'+n+'/verification.json'))"`, false, "concatenated relative path fragment");
case_(`python3 -c "j=json.load(open(d+'/verification.json'))"`, false, "fragment appended to a variable");
case_(`python3 -c "p=d; p += '/x.json'; open(p)"`, false, "fragment appended with +=");
case_(`node -e "fs.readFileSync(d + '/a.json')"`, false, "node fragment");
case_(`ruby -e 'File.read(d+"/x")'`, false, "ruby fragment");
case_(`perl -e 'open F, $d."/x"'`, false, "perl . concatenation fragment");
case_(`python3 -c "open('/etc/'+n)"`, true, "literal before + is a real absolute prefix");
case_(`python3 -c "open(os.path.join(d,'/etc/passwd'))"`, true, "join with an absolute argument restarts at it");
case_(`python3 -c "open(d+'/../../../../etc/passwd')"`, true, "fragment escaping the cwd is checked as relative");
case_(`python3 -c "open(''+'/etc/passwd')"`, true, "static concatenation of literals stays absolute");
case_(`perl -e 'open F, ""."/etc/passwd"'`, true, "perl static concatenation stays absolute");
case_(`python3 -c "os.system(d+' && cat /etc/passwd')"`, true, "fragment holding a command line is still analysed");

if (failed > 0) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
} else {
	console.log(`\nAll ${passed} test(s) passed`);
}
