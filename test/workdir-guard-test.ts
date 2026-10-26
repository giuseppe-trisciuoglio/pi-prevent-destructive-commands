import { checkCommandWorkdir, checkPathInsideWorkdir } from "../src/rules/workdir-guard";
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
	const status = ok ? "PASS" : "FAIL";
	if (ok) passed++;
	else failed++;
	console.log(`${status} ${command} ${note ? `- ${note}` : ""}`);
	if (!ok) {
		console.error(`  expected blocked=${expectBlocked}, got blocked=${blocked} reason=${result.reason}`);
	}
}

case_("cat ./README.md", false, "relative path inside cwd");
case_("cat src/index.ts", false, "relative path inside cwd");
case_("ls .", false, "dot is inside cwd");
case_("ls ./subdir", false, "subdir inside cwd");

case_("cat /etc/passwd", true, "absolute path outside cwd");
case_("rm /tmp/../etc/passwd", true, "path traversal outside cwd");
case_("cat ../../secret.txt", true, "parent dir traversal outside cwd");
case_("cat ~/document.txt", true, "home dir outside cwd");
case_("cp /var/log/syslog ./", true, "absolute source outside cwd");

case_("cat /tmp/file.txt", false, "tmp path allowed");
case_("cp ./file.txt /tmp/", false, "tmp destination allowed");
case_("rm /tmp/temp.log", false, "tmp removal allowed");
case_("mkdir /tmp/newdir", false, "tmp mkdir allowed");

case_("echo hello", false, "no path");
case_("git status", false, "no path");
case_("npm install", false, "no path");

const okInside = checkPathInsideWorkdir("src/file.ts", CWD, CWD);
console.log(okInside.dangerous ? "FAIL" : "PASS", "checkPathInsideWorkdir relative inside");

const okTmp = checkPathInsideWorkdir("/tmp/x", CWD, CWD);
console.log(okTmp.dangerous ? "FAIL" : "PASS", "checkPathInsideWorkdir tmp allowed");

const badOutside = checkPathInsideWorkdir("/etc/passwd", CWD, CWD);
console.log(badOutside.dangerous ? "PASS" : "FAIL", "checkPathInsideWorkdir outside blocked");

if (failed > 0) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
} else {
	console.log(`\nAll ${passed} test(s) passed`);
}
