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

if (failed > 0) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
} else {
	console.log(`\nAll ${passed} test(s) passed`);
}
