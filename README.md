# Prevent Destructive Commands

[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![pi Extension](https://img.shields.io/badge/pi-extension-purple.svg)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)

> **Unconditionally blocks destructive bash commands before execution.** A pi extension that guards your codebase against accidental data loss from `rm`, `git reset --hard`, `docker rm`, `aws delete` operations, and more.

A faithful port of Claude's `prevent-destructive-commands.py` hook, adapted for the [pi coding agent](https://pi.dev). Same rule set, same recursive tokenizer — same peace of mind.

---

## Features

- **Hard-block protection** — Dangerous commands are blocked unconditionally. The agent receives a clear reason and must find a safe alternative.
- **Works in all modes** — Protection is active even in non-interactive sessions (`-p`, JSON, RPC).
- **Recursive analysis** — Traverses command wrappers, shell invocations, pipelines, and nested commands to catch obfuscated attacks.
- **Configurable** — Tune protection levels via simple flags in `src/config.ts`.
- **Zero dependencies** — Lightweight, fast, and self-contained.
- **70+ test cases** — Comprehensive smoke test suite validates all blocking rules.

## What Gets Blocked

All rules are defined in [`src/config.ts`](src/config.ts) and can be customized.

| Category | Examples |
|----------|----------|
| **Destructive Git** | `git reset --hard`, `git clean`, `git push --force` / `-f` / `--delete`, `git branch -D`, `git tag -d`, `git checkout -f`, `git rebase`, `git filter-branch`, `git filter-repo`, `git reflog expire`, `git update-ref -d` |
| **Git add/commit** | `git add`, `git commit` *(see `ENABLE_GIT_ADD_COMMIT_BLOCK` flag)* |
| **rm / path-sensitive** | `rm`, `rmdir`, `shred`, `unlink` targeting paths **outside** the working directory (e.g., `/etc`, `~`, `..`). Targets inside cwd are allowed. |
| **Destructive Docker** | `docker rm` / `rmi`, `docker container/image/volume/network rm`, `docker * prune`, `docker compose down -v`, `docker compose rm`, `docker context rm`, `docker swarm leave --force` |
| **Destructive AWS CLI** | `aws s3 rm`, `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws cloudformation delete-stack`, and 50+ more subcommands (full list in `src/config.ts`) |
| **Sensitive file reads** | `cat`, `grep`, etc. on `.env`, SSH keys, `.pem` files — **disabled by default** via `ENABLE_SENSITIVE_FILE_CHECK` *(see Configuration)* |

### Recursive Analysis

The analyzer traverses common command wrappers and nested structures so a destructive command can't hide:

- **Wrappers**: `sudo`, `env`, `timeout`, `nice`, `nohup`, `ionice`, `time`
- **Shell invocations**: `bash -c "..."`, `sh -c "..."`, `zsh -c "..."`
- **Execution delegation**: `find -exec`, `xargs`, `parallel`
- **Quoted wrappers**: `watch "rm foo"`, `strace "..."`
- **Pipelines & chains**: `|`, `&&`, `||`, `;`

---

## Installation

### Via pi Marketplace

```bash
pi install @giuseppetrisciuoglio/pi-prevent-destructive-commands
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
| `ENABLE_GIT_ADD_COMMIT_BLOCK` | `true` | Blocks `git add` and `git commit`. Set to `false` if you want the agent to create commits autonomously. |
| `ENABLE_SENSITIVE_FILE_CHECK` | `false` | Blocks reading of sensitive files (`.env`, SSH keys, credentials). Disabled by default due to false positives from substring matching (`config` matches `tsconfig`, `vite.config`; `.env` matches `.environment.ts`). Enable only if needed and consider refining `SENSITIVE_FILE_PATTERNS`. |
| `MAX_NESTING_DEPTH` | `5` | Maximum command nesting depth before treating as obfuscated. |

After any change, reload the extension:

```bash
pi /reload
```

---

## Project Structure

```
prevent-destructive-commands/
├── src/
│   ├── index.ts          # Extension entry point (factory + tool_call hook)
│   ├── config.ts         # Blacklists and behavior flags — tune protection here
│   ├── tokenizer.ts      # Shell tokenizer (shlex-like)
│   ├── checker.ts        # Recursive command walker (wrappers/shell/find/xargs)
│   └── rules/            # Per-category destructive-command handlers
│       ├── types.ts          # Shared CheckResult type + helpers
│       ├── path-utils.ts      # cwd-relative path resolution
│       ├── git.ts             # git reset --hard, push --force, ...
│       ├── docker.ts          # docker rm, system prune, ...
│       ├── aws.ts             # aws s3 rm, ec2 terminate-instances, ...
│       ├── file-reading.ts    # sensitive file read detection
│       └── path-sensitive.ts  # rm/rmdir/... outside-cwd detection
├── test/
│   └── smoke-test.ts     # Standalone test suite (70+ cases)
├── tsconfig.json     # TypeScript configuration
├── package.json      # Package metadata for pi marketplace
└── README.md         # This file
```

---

## Testing

Run the comprehensive smoke test suite:

```bash
# Using npm
npm test

# Or directly with tsx
npx tsx test/smoke-test.ts

# Or with jiti
npx jiti test/smoke-test.ts
```

The test suite covers:
- All destructive Git operations
- Path-sensitive `rm` protection
- Docker destructive commands
- AWS CLI destructive subcommands
- Wrapper traversal (`sudo`, `env`, `timeout`)
- Shell invocation traversal (`bash -c`)
- `find -exec` and `xargs` delegation
- Pipeline and concatenation handling
- Git global flag parsing (`-C`, `--git-dir`)
- Edge cases and safe command verification

---

## Known Limitations

As with the original Claude plugin, the analysis is static and therefore cannot cover everything:

| Limitation | Example | Explanation |
|------------|---------|-------------|
| **Arguments via stdin/pipe** | `echo x \| xargs rm` | The arguments to `rm` are not visible as tokens — they arrive via stdin. |
| **cd in command** | `cd /; rm etc/passwd` | Evaluated against pi's cwd, not `/`. In practice pi rarely uses `cd` (cwd is already the project root), so risk is low. |
| **Unknown wrappers** | Custom destructive tools | The extension covers known patterns; unknown wrappers or custom destructive tools are not intercepted. |

---

## How It Works

When pi attempts to execute a bash command, this extension intercepts the `tool_call` event and:

1. **Tokenizes** the command string using a shlex-like shell tokenizer that respects quotes and escapes.
2. **Analyzes** the token stream recursively, traversing wrappers, shell invocations, and pipelines.
3. **Blocks** if any destructive pattern is detected, returning a clear reason to the agent.
4. **Allows** safe commands to pass through without modification.

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

- Inspired by and ported from Claude's `prevent-destructive-commands.py` hook.
- Built for the [pi coding agent](https://pi.dev) ecosystem.
