# Prevent Destructive Commands

[![CI](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/actions/workflows/ci.yml/badge.svg)](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)

> **Unconditionally blocks destructive bash commands before execution.** A pi extension that guards your codebase against accidental data loss from `rm`, `git reset --hard`, `docker rm`, `aws delete` operations, and more.

A faithful port of Claude's [`prevent-destructive-commands.py`](https://github.com/giuseppe-trisciuoglio/developer-kit/blob/main/plugins/developer-kit-core/hooks/prevent-destructive-commands.py) hook, adapted for the [pi coding agent](https://pi.dev). Same rule set, same recursive tokenizer — same peace of mind.

---

## Features

- **Hard-block protection** — Dangerous commands are blocked unconditionally. The agent receives a clear reason and must find a safe alternative.
- **Works in all modes** — Protection is active even in non-interactive sessions (`-p`, JSON, RPC).
- **Recursive analysis** — Traverses command wrappers, shell invocations, pipelines, and nested commands to catch obfuscated attacks.
- **Nx configuration guard** — In Nx workspaces, existing `package.json` and TypeScript configuration files are immutable to the agent; missing ones can still be created.
- **Source comment guard** — The agent cannot introduce new comments into source files (Java, TypeScript, Dart, Python, SQL, HTML, and more) through writing tools or bash write vectors; existing comments may be carried over untouched and tooling directives (`@ts-ignore`, `eslint-disable`, …) stay allowed.
- **Read-only mode** — `/read-only on` turns the project into an inspection-only workspace: `write`, `edit`, patch tools, `bash`, and `powershell` are blocked while `read`, `grep`, `find`, and `ls` keep working.
- **Workdir boundary guard** — Every file read, write, edit, and delete is confined to the working directory where pi runs. System temp directories (`/tmp`, `os.tmpdir()`) are allowed, and shell output can be discarded through `/dev/null`; the temp root itself stays protected. Installed skills (`~/.agents/skills/`, `~/.pi/skills/`) stay readable but are never written.
- **Configurable** — Tune protection levels via simple flags in `src/config.ts`.
- **Zero dependencies** — Lightweight, fast, and self-contained.
- **Extensive test suite** — Smoke tests plus guard-specific and slash-command tests validate every blocking rule.

## What Gets Blocked

All rules are defined in [`src/config.ts`](src/config.ts) and can be customized.

| Category | Examples |
|----------|----------|
| **Destructive Git** | `git reset --hard`, `git clean`, `git push --force` / `-f` / `--delete`, `git branch -D`, `git tag -d`, `git checkout -f`, `git rebase`, `git filter-branch`, `git filter-repo`, `git reflog expire`, `git update-ref -d` |
| **Git add/commit/push** | `git add`, `git commit`, `git push` *(see `ENABLE_GIT_ADD_COMMIT_BLOCK` flag and the per-project opt-out below; force/delete push variants are always blocked)* |
| **Interactive git commit** | `git commit` without a message option (`-m`/`--message`, `-F`/`--file`, `-C`/`--reuse-message`, `-c`/`--reedit-message`, `--no-edit`, `--fixup`, or combined short forms like `-am`) — it would open the editor and hang the session. Always blocked, even when the project opts out of the git add/commit/push guards. |
| **rm / path-sensitive** | `rm`, `rmdir`, `shred`, `unlink` targeting paths **outside** the working directory (e.g., `/etc`, `~`, `..`). Targets inside cwd are allowed. |
| **find outside cwd** | `find` whose search root is **outside** the working directory (e.g., `find /etc`, `find ~`, `find ..`). Search roots inside cwd are allowed; `-exec` payloads are analyzed recursively as before. |
| **Destructive Docker** | `docker rm` / `rmi`, `docker container/image/volume/network rm`, `docker * prune`, `docker compose down -v`, `docker compose rm`, `docker context rm`, `docker swarm leave --force` |
| **Destructive GitHub CLI** | `gh api -X DELETE` / `gh api --method DELETE`, `gh repo delete` / `rename`, `gh release delete`, `gh gist delete`, `gh secret delete`, `gh variable delete`, `gh label delete`, `gh workflow disable`, `gh run delete` |
| **Destructive AWS CLI** | `aws s3 rm`, `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws cloudformation delete-stack`, and 50+ more subcommands (full list in `src/config.ts`) |
| **Paths outside the workdir** | Any tool or bash command touching a path that resolves outside the working directory: `cat /etc/passwd`, `cp ~/.ssh/id_rsa ./`, `write`/`edit` to `../outside.ts`, `apply_patch` creating files outside cwd, `cd /etc && cat passwd`. Paths under a system temp directory (`/tmp`, `os.tmpdir()`) are allowed; the temp root itself is not. Shell redirection to `/dev/null` is allowed, while direct access to it and other paths under `/dev` remain blocked *(see the per-project opt-out below)* |
| **Writes to skills** | Writing to an installed skill under `~/.agents/skills/` or `~/.pi/skills/`: `write`/`edit`/`apply_patch`, `echo x > SKILL.md`, `tee`, `cp`, `mv`, `chmod`. Reading those skills is allowed. |
| **Sensitive file reads** | `cat`, `grep`, etc. on `.env`, SSH keys, `.pem` files — **disabled by default** via `ENABLE_SENSITIVE_FILE_CHECK` *(see Configuration)* |
| **Existing Nx configuration** | `package.json`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.lib.json`, and `tsconfig.spec.json` anywhere below a workspace containing `nx.json`. Creating a missing file is allowed; changing or deleting an existing file is blocked. |
| **New comments in source files** | Any tool call that introduces a **new** comment into a source file: `write`/`edit`/`apply_patch` touching Java, TypeScript/JavaScript, Dart, Go, Rust, C/C++, C#, Swift, Kotlin, Scala, PHP, CSS/SCSS, Python, Ruby, shell, YAML, TOML, Terraform, GraphQL, SQL, Lua, Haskell, Elm, HTML/XML/SVG/Markdown files, plus bash write vectors (`cat > a.ts <<EOF`, `tee b.py <<EOF`, `echo "// x" >> c.ts`). Comments already in the file may be carried over; shebang lines, tooling directives (`@ts-ignore`, `eslint-disable`, `biome-ignore`, `noqa`, …) and purely decorative lines are exempt *(see the per-project opt-out below)* |

### Recursive Analysis

The analyzer traverses common command wrappers and nested structures so a destructive command can't hide:

- **Wrappers**: `sudo`, `env`, `timeout`, `nice`, `nohup`, `ionice`, `time`
- **Shell invocations**: `bash -c "..."`, `sh -c "..."`, `zsh -c "..."`
- **Execution delegation**: `find -exec`, `xargs`, `parallel`
- **Quoted wrappers**: `watch "rm foo"`, `strace "..."`
- **Pipelines & chains**: `|`, `&&`, `||`, `;`
- **Executed heredoc bodies**: `bash <<'EOF' ... EOF`, `cat <<EOF | python3`, `ssh host <<EOF` — the body is stdin data, so it is only analyzed as commands when the command line contains an executor (shell, interpreter, `ssh`, `xargs`, ...) that would actually run it

### Heredoc Handling

A heredoc body (`cat > notes.md <<'EOF' ... EOF`) is **data written to stdin, not a command line**, so it is not token-analyzed as shell syntax. This prevents false positives from natural language: e.g. Italian prose containing `del` (the Windows delete command name) followed by a markdown glob or an absolute path mentioned in the text.

When the command line carrying the heredoc contains an **executor** — a shell (`bash`, `sh`, ...), `xargs`/`parallel`, an interpreter (`python`, `node`, `ruby`, ...), `ssh`, `awk`/`sed`/`ed`, `crontab`, `sqlite3`/`psql`/`mysql`, and similar (full list in `HEREDOC_EXECUTOR_COMMANDS` in `src/config.ts`) — the body *is* still analyzed as commands, because it will actually be executed. This covers `bash <<EOF`, `cat <<EOF | bash`, and remote execution via `ssh`.

Anything the extractor cannot parse unambiguously (here-strings `<<<`, variable delimiters `<<$D`, missing terminator, mid-word quoting) falls back to analyzing the whole string exactly as before — the guard stays strict rather than guessing.

---

## Installation

### Via pi Marketplace

```bash
pi install npm:@giuseppe.trisciuoglio/pi-prevent-destructive-commands
```

### Manual Installation

1. Clone this repository into your pi extensions directory:

```bash
git clone https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands.git \
  ~/.pi/agent/extensions/prevent-destructive-commands
```

2. Reload pi to discover the extension:

```bash
pi /reload
```

The extension is automatically discovered by pi in all projects.

---

## Configuration

Edit the constants in [`src/config.ts`](src/config.ts) to tune protection:

| Flag | Default | Description |
|------|---------|-------------|
| `ENABLE_GIT_ADD_COMMIT_BLOCK` | `true` | Blocks `git add`, `git commit`, and plain `git push`. Set to `false` if you want the agent to commit and push autonomously; can be overridden per project via `.pi/prevent-destructive-commands.json` (see below). |
| `ENABLE_SENSITIVE_FILE_CHECK` | `false` | Blocks reading of sensitive files (`.env`, SSH keys, credentials). Disabled by default due to false positives from substring matching (`config` matches `tsconfig`, `vite.config`; `.env` matches `.environment.ts`). Enable only if needed and consider refining `SENSITIVE_FILE_PATTERNS`. |
| `MAX_NESTING_DEPTH` | `5` | Maximum command nesting depth before treating as obfuscated. |

After any change, reload the extension:

```bash
pi /reload
```

### Per-Project Opt-Out

Create `.pi/prevent-destructive-commands.json` in the project root to tune the guards **for that project only**:

```json
{
	"disableGitGuards": true,
	"disableCommentGuard": true,
	"readOnly": false,
	"disableWorkdirGuard": false
}
```

| Flag | Default | Effect |
|------|---------|--------|
| `disableGitGuards` | `false` | Disables the `git add` / `git commit` / `git push` guards. |
| `disableCommentGuard` | `false` | Disables the source comment guard, allowing the agent to write comments into source files again. |
| `readOnly` | `false` | When `true`, blocks every mutating tool call (`write`, `edit`, patch tools, `bash`, `powershell`) while read-only tools keep working. |
| `disableWorkdirGuard` | `false` | Disables the workdir boundary guard, allowing the agent to touch paths outside the working directory again. |

Or use the `/git-guards` slash command from the pi TUI:

| Command | Effect |
|---------|--------|
| `/git-guards` | Show whether the guards are active for the current project, and the state of the opt-out file. |
| `/git-guards off` | Write `{"disableGitGuards": true}` (unrelated JSON keys are preserved). |
| `/git-guards on` | Write `{"disableGitGuards": false}`. |

### Read-Only Mode

Use the `/read-only` slash command to make the project inspection-only:

| Command | Effect |
|---------|--------|
| `/read-only` | Show whether read-only mode is active for the current project, and the state of the configuration file. |
| `/read-only on` | Write `{"readOnly": true}` (unrelated JSON keys are preserved). |
| `/read-only off` | Write `{"readOnly": false}`. |

While read-only mode is active, the agent can inspect files with `read`, `grep`, `find`, and `ls`, but `write`, `edit`, every patch-style tool, `bash`, and `powershell` are blocked with a clear reason. Read-only mode is independent of the destructive-command, git, migration, Nx, and comment guards, and it defaults to off when the configuration file is missing or invalid.

### Workdir Boundary Guard

The workdir boundary guard keeps every filesystem operation inside the working directory where pi is running. It covers bash commands (including `cd` tracking inside a command chain) and the file tools (`read`, `write`, `edit`, `apply_patch`).

Allowed without any opt-out:

- paths inside the working directory, relative or absolute;
- paths under a system temp directory (`/tmp`, `os.tmpdir()`), so temp files keep working;
- shell output and error redirection to the Unix null device (`2>/dev/null`, `>/dev/null`);
- **reading** the installed skills, under `~/.agents/skills/` and `~/.pi/skills/`;
- glob patterns that expand from a directory inside the working directory (`docs/agent/*.md`, `src/**/*.tsx`).

Blocked: any path resolving outside the workdir — parent traversals (`../..`), absolute paths such as `/etc/passwd`, home-directory shortcuts (`~/file`), unresolvable variables (`$HOME/x`), `cd` out of the boundary, and the temp root itself (`rm -rf /tmp`). The null device is only allowed as a shell redirect destination: direct reads, ordinary writes, file-tool writes, destructive commands, and other paths under `/dev` remain blocked.

Command-specific operands are classified before paths are checked. Message text passed to git (`git commit -m "..."`, `git tag -m "..."`, `--message=...`, and similar options on `commit`, `tag`, `merge`, `notes`, `stash`) is free text and is never analyzed for paths, so a message can mention path-like words such as `/conversazioni` without being blocked. Path-valued git options (`-F`/`--file`, `--template=`) and path arguments such as `git add /etc/passwd` still follow the workdir boundary. A read-only, slash-delimited `sed` address such as `sed -n '/pattern/p' input.html` is a script, not a filesystem path. `sed` input files and script files supplied with `-f` or `--file` still follow the workdir boundary, while scripts that write files or execute commands remain blocked.

Glob patterns are decided from the directory they expand from, the part of the pattern before the first wildcard. `ls docs/agent/*.md` is allowed because `docs/agent` is inside the workdir; `ls /etc/*.conf` and `ls ../*.txt` are blocked because their expansion directory is outside it. A pattern that walks out of the directory it expands from (`docs/*/../../etc/passwd`) is blocked as well, because the reachable set cannot be bounded statically. The skills and system temp exceptions apply to glob patterns too: reading `~/.agents/skills/*/SKILL.md` is allowed, writing `~/.agents/skills/*` is blocked, and `rm /tmp/*.log` is allowed while `rm -rf /tmp` is not.

Skills are read-only: the agent can load a skill to follow its instructions, but cannot modify one. `write`, `edit`, `apply_patch`, shell redirects and write commands (`tee`, `cp`, `mv`, `install`, `ln`, `truncate`, `dd`, `chmod`, `chown`, `chgrp`) targeting a skills directory are blocked, because skills are instructions pi loads on future runs and writing there would be a persistence channel.

| Command | Effect |
|---------|--------|
| `/workdir-guard` | Show whether the guard is active for the current project, and the state of the configuration file. |
| `/workdir-guard off` | Write `{"disableWorkdirGuard": true}` (unrelated JSON keys are preserved). |
| `/workdir-guard on` | Write `{"disableWorkdirGuard": false}`. |

The exception for system temp directories applies to every guard, so `rm /tmp/scratch.log` and `tee /tmp/out.txt` keep working while the workdir boundary stays enforced.

Notes:

- Forceful and deleting push variants (`--force`, `-f`, `--force-with-lease`, `-d`, `--delete`) are **always blocked** and cannot be opted out.
- There is no global fallback: the file only applies to the project it lives in. A missing or invalid file keeps the guards active (safe default).
- The file is user-managed: the agent is blocked from creating or editing it via writing tools or bash. `/git-guards` is exempt because it runs only on explicit user invocation in the extension process.
- Changes are picked up live (mtime-based cache): the next tool call sees the new state immediately.

---

## Project Structure

```
prevent-destructive-commands/
├── src/
│   ├── index.ts          # Extension entry point (factory + tool_call hook)
│   ├── config.ts         # Blacklists and behavior flags — tune protection here
│   ├── command-analysis.ts # Shared token cursor, heredoc, and nested-command helpers
│   ├── tokenizer.ts      # Shell tokenizer (shlex-like)
│   ├── checker.ts        # Recursive command walker (wrappers/shell/find/xargs)
│   ├── read-only-command.ts # /read-only toggle and read-only tool-call gate
│   ├── workdir-guard-command.ts # /workdir-guard toggle
│   ├── migration-guard.ts
│   ├── nx-guard.ts       # Protects existing Nx package and TypeScript configuration files
│   ├── comment-guard.ts  # Blocks new comments written into source files
│   ├── patch-paths.ts    # Shared patch/file-path extraction from tool inputs
│   ├── token-segments.ts # Shared command-segment splitting for bash-level guards
│   └── rules/            # Per-category destructive-command handlers
│       ├── types.ts          # Shared CheckResult type + helpers
│       ├── args.ts           # Token-scanning helpers (positional args, subcommand matching)
│       ├── path-utils.ts      # cwd-relative path resolution, temp and skill roots
│       ├── glob.ts            # Wildcard detection and glob pattern splitting
│       ├── git.ts             # git reset --hard, push --force, ...
│       ├── docker.ts          # docker rm, system prune, ...
│       ├── aws.ts             # aws s3 rm, ec2 terminate-instances, ...
│       ├── file-reading.ts    # sensitive file read detection
│       ├── path-sensitive.ts  # rm/rmdir/... outside-cwd detection
│       └── workdir-guard.ts   # workdir boundary guard (filesystem tools + bash)
├── test/
│   ├── smoke-test.ts        # Standalone test suite (79+ cases)
│   ├── helpers.ts           # Shared test utilities (check, makeProject, runCheckCases, ...)
│   ├── migration-guard-test.ts
│   ├── nx-guard-test.ts     # Verifies Nx configuration protection and allowed creation
│   ├── comment-guard-test.ts # Verifies new-comment blocking across write, edit, patch, bash
│   ├── glob-guard-test.ts    # Verifies glob patterns inside and outside the workdir
│   └── e2e-install-test.ts  # End-to-end: verifies real installation/discovery by pi
├── tsconfig.json     # TypeScript configuration
├── package.json      # Package metadata for pi marketplace
└── README.md         # This file
```

---

## Testing

Run the full test suite (command safety, migration, Nx, workdir boundary, slash commands, and end-to-end checks):

```bash
npm test
```

### Smoke tests

Standalone tests for the tokenizer/checker logic (no dependency on pi itself):

```bash
npm run test:smoke
npm run test:heredoc
npm run test:nx-guard
npm run test:comment-guard
npm run test:workdir-guard
npm run test:workdir-guard-command
npm run test:glob-guard
```

Or run a single file directly with tsx or jiti:

```bash
npx tsx test/smoke-test.ts
npx jiti test/smoke-test.ts
```

### End-to-end installation test

Uses the real `@earendil-works/pi-coding-agent` package to verify the extension actually installs the way the [Installation](#installation) section describes:

- The `pi.extensions` entry in `package.json` resolves to an existing file.
- Manual installation (cloning into `<agentDir>/extensions/prevent-destructive-commands`) is discovered and loaded by pi's own extension loader.
- `pi install <path>` records the package and pi can subsequently discover and load it.
- Once loaded through that real pipeline, the registered `tool_call` handler still blocks/allows commands correctly.

```bash
npm run test:e2e

# Or directly with tsx
npx tsx test/e2e-install-test.ts
```

The test suite covers:
- All destructive Git operations
- Existing Nx package and TypeScript configuration protection, including direct tool writes, patches, shell redirection, and package-manager dependency changes
- Source comment blocking across `write`, `edit`, `apply_patch`, and bash write vectors (heredoc, `tee`, `echo`/`printf`), including string-literal false-positive checks and the per-project opt-out
- Path-sensitive `rm` protection
- Docker destructive commands
- AWS CLI destructive subcommands
- Wrapper traversal (`sudo`, `env`, `timeout`)
- Shell invocation traversal (`bash -c`)
- `find -exec` and `xargs` delegation
- Pipeline and concatenation handling
- Git global flag parsing (`-C`, `--git-dir`)
- Heredoc bodies: prose through data sinks is allowed, executed bodies (`bash <<EOF`, `cat <<EOF | bash`, `ssh`, interpreters) are still blocked, unparseable heredocs fall back to whole-string analysis
- Edge cases and safe command verification

---

## Known Limitations

As with the original Claude plugin, the analysis is static and therefore cannot cover everything:

| Limitation | Example | Explanation |
|------------|---------|-------------|
| **Unknown wrappers** | Custom destructive tools | The extension covers known patterns; unknown wrappers or custom destructive tools are not intercepted. |
| **Comment guard scope** | `python -c`, `sed` insertion; `.vue`/`.svelte`/`.astro` files | The comment guard covers writing tools and the common bash write vectors (heredoc, `tee`, `echo`/`printf` arguments); other generators are not intercepted. Mixed-language single-file components are excluded to avoid false positives across template/script/style blocks. A bash rewrite of an existing file counts every comment in the heredoc body as new. |

Two cases that used to be listed here are now handled:

- **Arguments via stdin/pipe** (`echo x \| xargs rm`) — a path-sensitive command (`rm`, `rmdir`, `shred`, ...) reached through `xargs`/`parallel` with no explicit target token is now blocked: its real targets arrive via stdin at runtime and can't be statically verified, so it's treated as dangerous rather than assumed safe. An explicit target (e.g. `xargs rm ./known-file`) is still checked normally against the working directory.
- **`cd` in command** (`cd /; rm etc/passwd`) — the analyzer now tracks `cd` within the same command chain (including `( … )` subshell scoping) and resolves subsequent relative paths against that effective directory, while still enforcing the *original* working directory as the safety boundary. `cd /; rm etc/passwd` now correctly resolves to `/etc/passwd` and is blocked. When a `cd` target itself can't be resolved statically (e.g. `cd "$VAR"`, `cd -`), any path-sensitive command that follows is blocked conservatively.

---

## How It Works

When pi attempts to execute a tool call, this extension intercepts the `tool_call` event and:

1. **Extracts heredoc bodies** so prose fed through `cat > file <<'EOF'` is treated as data, keeping bodies under analysis only when an executor on the command line would run them.
2. **Tokenizes** the command string using a shlex-like shell tokenizer that respects quotes and escapes.
3. **Analyzes** the token stream recursively, traversing wrappers, shell invocations, and pipelines.
4. **Checks writing tool calls** against the file-content guards: immutable Nx configuration, and new comments introduced into source files (string-aware, per language family, with only-newly-introduced comments blocked).
5. **Blocks** if any destructive pattern is detected, returning a clear reason to the agent.
6. **Allows** safe commands to pass through without modification.

The agent never receives an interactive prompt — the block is final and must be handled by finding a safe alternative.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Quick start for contributors:

```bash
git clone https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands.git
cd pi-prevent-destructive-commands
npm install
npm test
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for version history.

---

## License

This project is licensed under the [MIT License](LICENSE).

---

## Acknowledgments

- Inspired by and ported from Claude's [`prevent-destructive-commands.py`](https://github.com/giuseppe-trisciuoglio/developer-kit/blob/main/plugins/developer-kit-core/hooks/prevent-destructive-commands.py) hook.
- Built for the [pi coding agent](https://pi.dev) ecosystem.
