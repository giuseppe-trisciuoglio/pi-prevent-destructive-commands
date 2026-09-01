# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.1.0...HEAD

[1.1.0]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.0.1...v1.1.0

[1.0.1]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/compare/v1.0.0...v1.0.1

[1.0.0]: https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands/releases/tag/v1.0.0
