# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Reorganized source files into `src/` and tests into `test/`.
- Split `checker.ts` into a slim recursive dispatcher plus per-category rule handlers under `src/rules/` (`git.ts`, `docker.ts`, `aws.ts`, `file-reading.ts`, `path-sensitive.ts`, `path-utils.ts`, `types.ts`). No behavior changes.

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
