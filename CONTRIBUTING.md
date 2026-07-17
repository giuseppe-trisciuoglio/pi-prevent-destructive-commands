# Contributing to prevent-destructive-commands

Thank you for your interest in contributing! This document provides guidelines for contributing to this project.

## Code of Conduct

Be respectful, constructive, and inclusive in all interactions.

## How to Contribute

### Reporting Issues

- Check if the issue already exists before creating a new one.
- Provide a clear description, steps to reproduce, and expected vs. actual behavior.
- Include the command that triggered (or failed to trigger) the block.
- Mention your pi version and Node.js version.

### Suggesting Enhancements

- Open an issue with the "enhancement" label.
- Describe the use case and the benefit.
- If proposing a new blocked command category, explain why it should be considered destructive.

### Pull Requests

1. Fork the repository and create a feature branch.
2. Make your changes with clear, focused commits.
3. Run the smoke tests: `npm test` (or `npx tsx test/smoke-test.ts`).
4. Update the README.md if your change affects user-facing behavior.
5. Update CHANGELOG.md under the "Unreleased" section.
6. Submit a pull request with a clear description.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/giuseppe-trisciuoglio/pi-prevent-destructive-commands.git
cd pi-prevent-destructive-commands

# Install dependencies
npm install

# Run smoke tests
npm test

# Type check
npm run typecheck
```

## Project Structure

```
prevent-destructive-commands/
├── src/
│   ├── index.ts          # Extension entry point (factory + tool_call hook)
│   ├── config.ts         # Blacklists and behavior flags
│   ├── tokenizer.ts      # Shell tokenizer (shlex-like)
│   ├── checker.ts        # Recursive command walker (wrappers/shell/find/xargs)
│   └── rules/            # Per-category destructive-command handlers
│       ├── types.ts
│       ├── path-utils.ts
│       ├── git.ts
│       ├── docker.ts
│       ├── aws.ts
│       ├── file-reading.ts
│       └── path-sensitive.ts
├── test/
│   └── smoke-test.ts     # Standalone test suite
├── tsconfig.json     # TypeScript configuration
└── package.json      # Package metadata
```

## Adding New Blocked Commands

To add a new command category:

1. Add the command patterns to the appropriate set in `src/config.ts`.
2. Add the checker logic to a new or existing handler in `src/rules/`, following the existing handler pattern (see `src/rules/git.ts` or `src/rules/docker.ts`), and wire it into the dispatch loop in `src/checker.ts`.
3. Add test cases to `test/smoke-test.ts`.
4. Update the README.md documentation.

## Style Guide

- Use English for all code comments and documentation.
- Use 2-space indentation (tabs converted to 2 spaces).
- Prefer explicit types over implicit ones.
- Keep functions focused and modular.

## Continuous Integration

Every push and pull request to `main` runs the [CI workflow](.github/workflows/ci.yml), which typechecks and runs the smoke test suite on Node.js 22 and 24.

## Releasing

Publishing to npm is handled by the [Publish workflow](.github/workflows/publish.yml) and is restricted to maintainers:

1. Bump `version` in `package.json` and move the relevant `CHANGELOG.md` entries from "Unreleased" to a new version section.
2. Commit and merge the version bump to `main`.
3. Create a GitHub Release with a tag matching `v<version>` (e.g. `v1.1.0`) for the merged commit.
4. Publishing the Release triggers the workflow, which verifies the tag matches `package.json`, re-runs typecheck/tests, and publishes to npm using the `NPM_TOKEN` repository secret.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
