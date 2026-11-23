# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Minor bypasses and false positives left from the #45/#46/#49 reviews are closed. `git worktree remove` treats any prefix of `--force` from `--f` as forced; `gh pr close -dRa/b` and `-dcmsg` are blocked (`-Rd` is still allowed). Workdir guard: `node --eval='…'`/`--print='…'`, `node -p -e '…'` and `node --max-old-space-size 100 -e '…'` are scanned as programs, `deno eval --check '…'` and a program after `--` are scanned, and an empty `--opt=` (`rg --color= foo /etc`, `--color= ''`, `--color= '*' /etc/x`) is classified under both readings (empty value, or value consumed) so the operands after it are checked as paths. An unquoted or double-quoted program operand containing `$(`, a backtick or `${` is analysed as a shell command line instead of opaque program text, for every inline-program form (`node --eval="$(cat /etc/passwd)"`, `node -e "$(…)"`, `python -c "$(…)"`); single-quoted JS template literals stay allowed. Comment guard: a `/` after the `)` of an `if`/`while`/`for` condition starts a regex literal only when the parentheses hold no quote or `/`, the keyword is not preceded by `.`, and the literal does not start with a space or end followed by `/` or `*`; otherwise it stays a division, so real comments are not hidden. Deliberate changes: `grep -r --include='*.ts' '/x/' .` is now blocked (a split `--opt=` is ambiguous, so a later `/x/` is checked as a path); `node`/`deno eval` programs written with a recognised option form (`node --stack-size 1 -e 'x; cat /etc/passwd'`, `deno eval --vendor '/etc/passwd'`, `deno eval -- '/etc/passwd'`) are now treated as code, exactly like `node -e '…'` already was. See issue #53 and ADRs 0011, 0012 and 0013.

- The comment guard now reports the line in the target file for `edit` and `apply_patch` violations instead of the line within `newText` or the added text (a one-line edit always said `file:1`). For `edit` the unique `oldText` is located in the current file (each `edits[]` entry on its own); for `apply_patch` the hunk header's `+start` is followed through context and added lines. When the file cannot be read, `oldText` is missing or ambiguous, or no hunk header is present, the old location is reported. The block/allow decision changes only in two diff edge cases, both deliberate: inside a hunk a removed line starting with `---` (such as `-- old`) is now a removed line, so re-adding it unchanged is allowed (main wrongly blocked it), and an added line starting with `+++` (such as `+++ # c`) is now an added line, so it is blocked (main missed it). `apply_patch` updates written with a bare `@@` or `@@ context` are located by matching the hunk's old-side lines in the current file (unique match required; the context text narrows the search); `\ No newline at end of file` markers are skipped, mid-hunk `+++`/`---` lines are treated as content only within the hunk's declared line counts (a bare `@@` hunk ends at a `---`/`+++` pair), blank lines inside a hunk count as empty context lines when the hunk continues, the search has a work budget (beyond it the old location is reported), absurd `+start` values are ignored, CRLF files match LF `oldText`, and the file is read only after a violation is found and only when it is a regular file (a FIFO never blocks). With several `edits[]` entries, line numbers refer to the file before any edit is applied. The block message now also says that rewording an existing comment counts as a new one. See issue #54.

- The workdir guard no longer blocks inline-program string literals that hold markup. `node -e 'var a="<script src=\"js/a.js\"></script>";'` was reported as `"/script" is outside the working directory` because a literal with whitespace and a `/` was re-analyzed as a shell command line, where `</script>` is a redirect from `/script`. Well-formed HTML/XML tags in such literals are now neutralised (replaced by their attribute values, names and quotes removed) before the normal command analysis runs, so `</script>` disappears while `src="/etc/passwd"`, `<a> cat >/etc/passwd` and `</etc/passwd>` (not a tag) are still blocked. See issue #55 and `docs/adr/0012-program-and-pattern-operands.md`.

- The comment guard no longer reports phantom comments after a regex literal containing a quote. `s.replace(/'/g, 'x')` followed by `'js/gimmicks/*.js'`, and `/a\/*b/`, are no longer blocked: C-family regex literals are recognised (expression position, escapes, character classes, flags), and when the string scan desynchronises (unterminated string, or a JS/TS quoted string spanning a line) the comments found before the failing string are kept and only comments that open a later line are reported. A `/` closing a JSX self-closing tag (`<A b={1} /> // x`), or following `}`, a postfix `++`/`--` or a TypeScript non-null `!`, is not taken as a regex, so trailing comments there are still blocked; Rust lifetimes (`'static`) are not char literals. A `..foo` directory counts as inside the project. Files outside the project working directory (e.g. `/tmp` scripts) are no longer checked. See issue #49 and `docs/adr/0013-comment-guard-regex-literals.md`.

- The workdir boundary guard no longer treats program and pattern operands starting with `/` as paths. `awk '/^<<<<<<</,/^>>>>>>>/' f`, `grep '/api/' f`, `grep -e/--regexp`, `rg '/api/' src`, `sed -n '/start/,/end/p' f` (ranges, `+N`, `\%re%`, multiple `-e`), `perl -ne 'print if /x/'`, `node -e "x.replace(/a/,'b')"` and `python3 -c "re.sub(r'/x/', ...)"` are allowed. Input files, `-f`/`--file` program and pattern files, interpreter script files, and string literals inside inline programs that name outside paths (`open('/etc/passwd')`, `system("cat /etc/passwd")`) are still blocked, as are `rg --files`/`--type-list` and `ag -g` search paths, `node -pe` programs, `deno eval --ext ts` code, and perl/ruby quote-like literals (`q(/etc/x)`, `%q(/etc/x)`). Separator literals made only of slashes (`split($0,a,"/")`) are not paths. Exempt tools: `grep`/`egrep`/`fgrep`, `rg`, `ag`, `awk`/`gawk`/`mawk`/`nawk`, `sed`, `node`/`bun`, `deno eval`, `python*`, `ruby`, `perl`. See issue #46 and `docs/adr/0012-program-and-pattern-operands.md`.

### Fixed

- Deletions performed as a side effect of high-level commands are now covered. `gh pr close --delete-branch` (and `-d`, `--delete-branch=true`, `-dc msg`, with `-R owner/repo` anywhere) is blocked, because the PR is unmerged and its commits may become unreachable. `git worktree remove --force` / `-f` / `-ff` / `-f -f` is blocked when the worktree has uncommitted or untracked changes, is locked, or its state cannot be checked; a clean, unlocked worktree is still removable. `gh pr merge --delete-branch` and `git worktree prune` stay allowed. See issue #45 and `docs/adr/0011-side-effect-deletions.md`.

## [1.4.9] - 2026-11-22

### Fixed

- The workdir boundary guard now lets the agent move into and read the system temp root: `cd /tmp`, `cd /private/tmp`, `pushd /tmp`, `ls /tmp` and relative paths after `cd /tmp` are allowed. Write, move and delete operations on the temp root itself stay blocked (`rm -rf /tmp`, `chmod 777 /tmp`, `mv /tmp ./x`), and `mv` sources are now treated as write targets because `mv` removes them. See issue #47 and `docs/adr/0010-temp-root-read-access.md`.

- Remote deletions are now blocked by effect, not by a single syntax. `gh api` blocks method `DELETE` in every spelling `gh` accepts (`-XDELETE`, `-X=DELETE`, `-iX DELETE`, ...) and a method that cannot be resolved statically (`-X "$M"`). `gh api graphql` blocks destructive mutations (`delete*`, `remove*`, `archive*`, `transfer*`, `updateRefs`) in inline queries, `-F query=@file` and `--input file`, and blocks payloads that cannot be inspected (stdin, unreadable file, variable-only query). Generic HTTP clients (`curl`, `wget`, HTTPie, `xh`) are blocked when they send `DELETE`, an unresolvable method or a destructive GraphQL mutation to GitHub API hosts. Read-only requests stay allowed. See issue #43 and `docs/adr/0009-effect-based-remote-deletion.md`.

- The workdir boundary guard no longer treats API endpoint arguments as filesystem paths. `gh api /repos/o/r/pulls`, `sonar api get "/api/ce/activity?project=x"` (also when the endpoint comes from a variable assigned in the same command), and HTTPie/xh (`http GET /api/health`) are allowed. File arguments of these clients are still checked: `gh api --input <file>`, and now also `gh api -F key=@file` and HTTPie `field=@file` / `field@file` items. See issue #41 and `docs/adr/0008-api-endpoint-arguments.md`.

## [1.4.8] - 2026-11-22

### Fixed

- The workdir boundary guard now allows `/dev/null` as the value of an output option (`-o`, `-O`, `--output`, `--output-document`), so commands such as `curl -s -o /dev/null -w '%{http_code}' URL` and `wget -q -O /dev/null URL` are no longer blocked. Output options pointing to other outside paths or devices, and `/dev/null` used as an operand of destructive or write commands (`rm`, `cp`, ...), remain blocked. See issue #37 and the amended `docs/adr/0004-null-device-redirection.md`.
- The workdir boundary guard now checks path values attached to long options (`--name=value`). `curl --output=/etc/passwd URL`, `wget --output-document=~/.bashrc URL` and `tar --file=/etc/shadow -t` are blocked, while `--output=/dev/null`, temp paths, paths inside the working directory, URLs, and free-text options (`--title`, `--body`, `--message`, `--format`, ...) are unaffected. See issue #39 and `docs/adr/0007-attached-option-values.md`.

## [1.4.7] - 2026-10-28

Cumulative entry: these changes were released across 1.2.1–1.4.7 and were not tracked per version at the time.

### Added

- New per-project read-only mode (`/read-only on|off|status`): when enabled, every mutating tool call is blocked — `write`, `edit`, any patch-style tool (`*apply_patch`), `bash`, and `powershell` — while read-only tools (`read`, `grep`, `find`, `ls`) keep working. The flag lives in `.pi/prevent-destructive-commands.json` under `readOnly` (default `false` when the file is missing or invalid), `/read-only` toggles it while preserving unrelated JSON keys, and it is independent of the destructive-command, git, migration, Nx, and comment guards. Adds `test/read-only-command-test.ts` (`npm run test:read-only-command`) and `docs/adr/0001-read-only-mode.md`.
- New guard: new comments in source files are blocked. Any tool call that would introduce a new comment into a source file (Java, TypeScript/JavaScript, Dart, Go, Rust, C/C++, C#, Swift, Kotlin, Scala, PHP, CSS/SCSS, Python, Ruby, shell, YAML, TOML, Terraform, GraphQL, SQL, Lua, Haskell, Elm, HTML/XML/SVG/Markdown) is stopped, covering `write`, `edit`, `apply_patch` (unified diff and `*** Begin Patch` formats), and bash write vectors (`cat > a.ts <<EOF`, `tee b.py <<EOF`, `echo "// x" >> c.ts`). Detection is string-aware (comment markers inside string literals are not comments), comments a file already contains may be carried over untouched, and shebang lines, tooling directives (`@ts-ignore`, `eslint-disable`, `biome-ignore`, `noqa`, …) and purely decorative lines are exempt. Opt out per project with `{"disableCommentGuard": true}` in the opt-out file. Adds `test/comment-guard-test.ts` (`npm run test:comment-guard`).
- New guard: interactive `git commit` without a message option (bare `git commit`, `git commit -a`, `git commit --amend`, ...) is blocked because it opens the editor and hangs the session when the agent runs unattended. Applies unconditionally, even on projects that opted out of the git add/commit/push guards; commits with a message (`git commit -m x`, `-F file`, `--amend --no-edit`, ...) are unaffected.

### Changed

- Extracted shared helpers to remove all code clones reported by jscpd (≥ 50 tokens): `src/rules/args.ts` (positional-argument scanning and longest-subcommand matching for the checker and the aws/gh/file-reading rules), `src/patch-paths.ts` (patch/file-path extraction shared by the extension entry point and the Nx guard), `src/token-segments.ts` (command-chain segmentation for the bash-level guards), and `test/helpers.ts` (shared test utilities: `check`, `makeProject`, `isBlocked`, `runCheckCases`, `runIsolatedTest`). No behavior change.
- Extracted the shared token cursor, heredoc orchestration, nested-command helpers, and `sed` operand classification into `src/command-analysis.ts`. The destructive-command checker and workdir guard now use the same analysis primitives without changing their command-specific decisions. The duplicate-code scan reports no clone of at least 50 tokens between the two analyzers.

### Fixed

- The workdir boundary guard no longer mistakes a read-only, slash-delimited `sed` address for an absolute filesystem path. Commands such as `sed -n '/pattern/p' input.html` are allowed, while `sed` input files, script files supplied with `-f` or `--file`, and scripts that write files or execute commands remain protected.
- The workdir boundary guard now allows shell output and error redirection to `/dev/null`, so common commands such as `grep -rn "pattern" docs/ .pi/ 2>/dev/null | head -30` are no longer blocked. The exception is limited to redirect destinations: direct reads, ordinary writes, file-tool writes, destructive commands, and other paths under `/dev` remain blocked. Adds regression coverage in `test/workdir-guard-test.ts`.
- The workdir boundary guard no longer analyzes git message text for paths. `git commit -m "feat(conversazioni): lista /conversazioni ..."`, `--message=...`, and messages on `git tag`, `git merge`, `git notes`, and `git stash` (including combined short flags such as `-am`) are treated as free text, while path-valued options (`-F`/`--file`, `--template=`) and path arguments such as `git add /etc/passwd` remain blocked. Adds regression coverage in `test/workdir-guard-test.ts` and `docs/adr/0006-git-message-free-text.md`.
- Glob patterns are no longer refused as unresolvable paths. The workdir boundary guard decides a pattern from the directory it expands from — the part before the first wildcard — so `ls docs/agent/*.md`, `grep -rn "x" frontend/src/pages/*.tsx` and `rm dist/*.log` work again, while `ls /etc/*.conf`, `ls ../*.txt` and `rm docs/*/../../etc/passwd` stay blocked. Shell variables (`$HOME/x`) and the `find -exec` placeholder (`{}`) are still refused, and the skills and system temp exceptions apply to patterns as well: reading `~/.agents/skills/*/SKILL.md` is allowed, writing `~/.agents/skills/*` is blocked, and `rm /tmp/*.log` is allowed while `rm -rf /tmp` is not. Adds `src/rules/glob.ts`, `test/glob-guard-test.ts` (`npm run test:glob-guard`) and `docs/adr/0003-glob-patterns.md`.

## [1.2.0] - 2026-09-28

### Added

- New guard: destructive GitHub CLI commands are blocked. `gh api` calls carrying a destructive method (`gh api -X DELETE ...`, `gh api --method DELETE ...`, including the `--method=DELETE` form) and destructive `gh` subcommands (`gh repo delete`, `gh repo rename`, `gh release delete`, `gh gist delete`, `gh secret delete`, `gh variable delete`, `gh label delete`, `gh workflow disable`, `gh run delete`) are stopped before execution. Safe `gh` usage (`gh api` GET/POST, `gh pr view`, ...) remains allowed. Adds `test/gh-guard-test.ts` (`npm run test:gh-guard`).

## [1.1.0] - 2026-09-01

### Added

- New guard: `find` commands whose search roots are outside the working directory are blocked (e.g. `find /etc`, `find ~`, `find ..`), including globbed start paths and search roots made unverifiable by a preceding unresolved `cd`. In-boundary starts (`find .`, `find src test`) remain allowed and `-exec` payload analysis is unchanged. Adds `test/find-start-path-test.ts` (`npm run test:find-start-path`).
- Nx workspace protection: blocks the agent from modifying or deleting existing `package.json`, `tsconfig.json`, `tsconfig.base.json`, `tsconfig.lib.json`, and `tsconfig.spec.json` files anywhere beneath a workspace with `nx.json`. Missing files remain creatable. The guard covers direct file tools, patches, common shell mutations, and package-manager dependency commands.
- CI GitHub Actions workflow: typecheck and smoke tests on Node.js 22 and 24 for every push/PR to `main`.
- Publish GitHub Actions workflow: publishes to npm when a GitHub Release is published, after verifying the release tag matches `package.json` and re-running typecheck/tests.
- End-to-end installation test (`test/e2e-install-test.ts`, `npm run test:e2e`): uses the real `@earendil-works/pi-coding-agent` package to verify manual installation and `pi install` are both discovered and loaded correctly, and that the loaded `tool_call` handler blocks/allows commands as expected. `npm test` now runs the smoke suite and the e2e test.
- New guard: plain `git push` is now blocked by default (force/delete variants were already blocked and remain unconditionally blocked).
- Per-project opt-out file `.pi/prevent-destructive-commands.json` (e.g. `{"disableGitGuards": true}`) disables the `git add` / `git commit` / `git push` guards for that project only. The file is project-level (no global fallback), picked up live via mtime caching, and the agent is blocked from creating or modifying it through writing tools or bash mutations — it must be managed manually by the user or via the new `/git-guards` command. Adds `test/project-config-test.ts` (`npm run test:project-config`).
- New `/git-guards` pi slash command: `/git-guards` shows the effective guard state for the current project (file present/missing/invalid), `/git-guards off` and `/git-guards on` write `disableGitGuards` to the opt-out file preserving unrelated JSON keys. The command runs only on explicit user invocation, so it is not affected by the agent-side write block. Adds `test/git-guards-command-test.ts` (`npm run test:git-guards-command`).

### Changed

- Reorganized source files into `src/` and tests into `test/`.
- Split `checker.ts` into a slim recursive dispatcher plus per-category rule handlers under `src/rules/` (`git.ts`, `docker.ts`, `aws.ts`, `file-reading.ts`, `path-sensitive.ts`, `path-utils.ts`, `types.ts`). No behavior changes.
- Added the `pi-package` keyword to the npm manifest so the extension is listed on pi.dev/packages.

### Fixed

- Heredoc bodies are no longer analyzed as shell command lines. Previously, prose written through `cat > file <<'EOF'` was tokenized as commands, so natural-language words colliding with command names (e.g. the Italian preposition `del`, which matches the Windows `del` delete command) followed by a path-like word (markdown `**glob**`, an absolute path mentioned in the text) produced false-positive blocks. Bodies are now extracted and only analyzed when the command line contains an executor that would actually run them (`bash <<EOF`, `cat <<EOF | bash`, `ssh <<EOF`, interpreters, `xargs`, … — `HEREDOC_EXECUTOR_COMMANDS` in `src/config.ts`). Anything not unambiguously parseable (here-strings `<<<`, variable delimiters, missing terminator, mid-word quoting) falls back to the previous whole-string analysis, and heredocs nested in `bash -c`/quoted-wrapper strings get the same treatment.
- `cd` within an analyzed command chain (e.g. `cd /; rm etc/passwd`) is now tracked: relative paths in subsequent path-sensitive commands resolve against the effective directory instead of the untouched real cwd, while the *original* cwd remains the safety boundary. `( … )` subshell scoping is respected — a `cd` inside parentheses no longer leaks out. A `cd` to a statically unresolvable target (`cd "$VAR"`, `cd -`) causes subsequent path-sensitive commands to be blocked conservatively.
- `xargs`/`parallel` delegating to a path-sensitive command (`rm`, `rmdir`, `shred`, ...) with no explicit target token (e.g. `echo x | xargs rm`) is now blocked: the real arguments arrive via stdin at runtime and can't be statically verified. An explicit target is still checked normally against the working directory.
- `package.json`'s `pi` manifest declared an `entryPoint` field that pi's extension loader does not read, so the extension was never discovered when manually installed by cloning into `<agentDir>/extensions/prevent-destructive-commands` as documented in the README. Replaced it with the `pi.extensions` array field that pi actually resolves.

## [1.0.1] - 2026-07-25

### Fixed

- Renamed the npm package scope from `@giuseppe-trisciuoglio/pi-prevent-destructive-commands` to `@giuseppe.trisciuoglio/pi-prevent-destructive-commands` to match the npm organization name.

## [1.0.0] - 2025-07-16

### Added

- Initial release of `prevent-destructive-commands` extension for pi.
- Unconditional hard-block of destructive bash commands before execution.
- Support for destructive Git operations: `git reset --hard`, `git clean`, `git push --force`, `git branch -D`, `git rebase`, `git filter-branch`, `git filter-repo`, and more.
- Support for destructive Docker operations: `docker rm`, `docker rmi`, `docker container/volume/image/network rm`, `docker * prune`, `docker compose down -v`, and more.
- Support for destructive AWS CLI operations: `aws s3 rm`, `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws cloudformation delete-stack`, and more (50+ subcommands).
- Path-sensitive protection for `rm`, `rmdir`, `unlink`, `shred`: blocks targets outside the working directory.
- Optional sensitive file read protection (`cat`, `grep`, etc. on `.env`, SSH keys, credentials) — disabled by default due to false positives.
- Recursive analysis through command wrappers: `sudo`, `env`, `timeout`, `nice`, `nohup`, `ionice`, `time`.
- Recursive analysis through shell invocations: `bash -c "..."`, `sh -c "..."`, etc.
- Recursive analysis through `find -exec`, `xargs`, `parallel`.
- Recursive analysis through quoted command wrappers: `watch`, `strace`, `ltrace`.
- Pipeline and concatenation support: `|`, `&&`, `||`, `;`.
- Configurable behavior flags in `config.ts`.
- Comprehensive smoke test suite with 70+ test cases.
- Full TypeScript support with type definitions.

### Security

- Hard-block design: the agent receives a reason and must find an alternative.
- No interactive confirmation — protection works in non-interactive modes (`-p`, JSON, RPC).
- Maximum nesting depth limit (5) to prevent obfuscation attacks.

[Unreleased]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.4.9...HEAD

[1.4.9]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.4.8...v1.4.9

[1.4.8]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.4.7...v1.4.8

[1.4.7]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.2.0...v1.4.7

[1.2.0]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.1.0...v1.2.0

[1.1.0]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.0.1...v1.1.0

[1.0.1]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.0.0...v1.0.1

[1.0.0]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/releases/tag/v1.0.0
