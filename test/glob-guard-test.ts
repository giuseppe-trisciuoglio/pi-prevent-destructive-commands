import { checkCommand } from "../src/checker";
import { checkCommandWorkdir, checkToolInputWorkdir } from "../src/rules/workdir-guard";
import { type CheckCase, check, finishTest, runCheckCases } from "./helpers";

const CWD = "/home/user/projects/demo";

const workdirCases: CheckCase[] = [
	{ command: "ls docs/agent/*.md", expectBlocked: false },
	{ command: "grep -rn \"mobile\" frontend/src/pages/*.tsx", expectBlocked: false },
	{ command: "cat src/*.ts", expectBlocked: false },
	{ command: "ls *.log", expectBlocked: false },
	{ command: "rm dist/*.log", expectBlocked: false },
	{ command: "grep -rn \"x\" src/**/*.ts", expectBlocked: false },
	{ command: "ls docs/*/index.ts", expectBlocked: false },
	{ command: "cat ~/.agents/skills/*/SKILL.md", expectBlocked: false },
	{ command: "rm /tmp/*.log", expectBlocked: false },
	{ command: "ls /etc/*.conf", expectBlocked: true },
	{ command: "ls ../*.txt", expectBlocked: true },
	{ command: "cat ~/notes/*.md", expectBlocked: true },
	{ command: "rm docs/*/../../etc/passwd", expectBlocked: true },
	{ command: "cat \"$HOME/secret\"", expectBlocked: true },
	{ command: "cat $HOME/*.md", expectBlocked: true },
	{ command: "find . -exec rm {} \\;", expectBlocked: true },
	{ command: "rm ~/.agents/skills/*", expectBlocked: true },
	{ command: "rm -rf /tmp", expectBlocked: true },
];

runCheckCases(workdirCases, (command) => checkCommandWorkdir(command, CWD));

const destructiveCases: CheckCase[] = [
	{ command: "rm docs/*.log", expectBlocked: false },
	{ command: "rm /etc/*.conf", expectBlocked: true },
	{ command: "rm ~/.agents/skills/*", expectBlocked: true },
	{ command: "find src/* -name \"*.ts\"", expectBlocked: false },
	{ command: "find ../* -name \"*.ts\"", expectBlocked: true },
];

runCheckCases(destructiveCases, (command) => checkCommand(command, CWD, 0, CWD));

check(
	"write inside cwd with a glob",
	checkToolInputWorkdir("write", { path: "docs/*.md" }, () => [], CWD).dangerous,
	false,
);
check(
	"write outside cwd with a glob",
	checkToolInputWorkdir("write", { path: "../*.md" }, () => [], CWD).dangerous,
	true,
);
check(
	"write to /etc with a glob",
	checkToolInputWorkdir("write", { path: "/etc/*.conf" }, () => [], CWD).dangerous,
	true,
);
check(
	"read a skill with a glob",
	checkToolInputWorkdir("read", {}, () => [], CWD, ["~/.agents/skills/*/SKILL.md"]).dangerous,
	false,
);
check(
	"write a skill with a glob",
	checkToolInputWorkdir("write", { path: "~/.agents/skills/*/SKILL.md" }, () => [], CWD).dangerous,
	true,
);

finishTest("glob guard");
