import { HEREDOC_EXECUTOR_COMMANDS, SHELL_OPERATORS } from "./config";
import { extractHeredocs } from "./heredoc";
import { forEachPositionalArg } from "./rules/args";
import { type CheckResult, SAFE } from "./rules/types";
import { tokenize } from "./tokenizer";

export interface CommandToken<T extends string | null> {
	token: string;
	index: number;
	currentCwd: T;
	startsCommand: boolean;
}

export interface CommandTokenCursor<T extends string | null> extends Iterable<CommandToken<T>> {
	next(): CommandToken<T> | undefined;
	setCurrentCwd(cwd: T): void;
	skipTo(index: number): void;
}

export function createCommandTokenCursor<T extends string | null>(
	tokens: readonly string[],
	cwd: T,
): CommandTokenCursor<T> {
	let index = 0;
	let currentCwd = cwd;
	let startsCommand = true;
	const cwdStack: T[] = [];

	function next(): CommandToken<T> | undefined {
		while (index < tokens.length) {
			const tokenIndex = index++;
			const token = tokens[tokenIndex];
			if (!token) continue;

			if (token === "(") {
				cwdStack.push(currentCwd);
				startsCommand = true;
				continue;
			}
			if (token === ")") {
				currentCwd = cwdStack.pop() ?? cwd;
				startsCommand = true;
				continue;
			}
			if (SHELL_OPERATORS.has(token)) {
				startsCommand = true;
				continue;
			}

			const entry: CommandToken<T> = {
				token,
				index: tokenIndex,
				currentCwd,
				startsCommand,
			};
			startsCommand = false;
			return entry;
		}
		return undefined;
	}

	return {
		next,
		setCurrentCwd(nextCwd: T): void {
			currentCwd = nextCwd;
		},
		skipTo(nextIndex: number): void {
			index = nextIndex;
		},
		[Symbol.iterator](): Iterator<CommandToken<T>> {
			return {
				next(): IteratorResult<CommandToken<T>> {
					const entry = next();
					return entry ? { value: entry, done: false } : { value: undefined, done: true };
				},
			};
		},
	};
}

export function analyzeHeredocCommand(
	command: string,
	analyzeTokens: (tokens: string[]) => CheckResult,
	analyzeBody: (body: string) => CheckResult,
): CheckResult {
	const extraction = extractHeredocs(command);
	if (extraction === null) {
		return analyzeTokens(tokenize(command));
	}

	const lineTokens = tokenize(extraction.text);
	const result = analyzeTokens(lineTokens);
	if (result.dangerous) return result;

	if (extraction.bodies.length > 0 && lineTokens.some((token) => HEREDOC_EXECUTOR_COMMANDS.has(token))) {
		for (const body of extraction.bodies) {
			const bodyResult = analyzeBody(body);
			if (bodyResult.dangerous) return bodyResult;
		}
	}

	return result;
}

export function checkQuotedCommandWrapper(
	tokens: string[],
	index: number,
	currentCwd: string,
	depth: number,
	analyze: (command: string, cwd: string, depth: number) => CheckResult,
): CheckResult {
	let dangerous: CheckResult | undefined;
	forEachPositionalArg(tokens, index, (argument) => {
		const result = analyze(argument, currentCwd, depth + 1);
		if (result.dangerous) {
			dangerous = result;
			return false;
		}
	});
	return dangerous ?? SAFE;
}

export function shellCommandScript(tokens: readonly string[], index: number): string | undefined {
	let cursor = index + 1;
	while (cursor < tokens.length) {
		const token = tokens[cursor]!;
		if (token === "-c" && cursor + 1 < tokens.length) {
			return tokens[cursor + 1]!;
		}
		if (token.startsWith("-")) {
			cursor++;
			continue;
		}
		break;
	}
	return undefined;
}

export interface SedOperandClassification {
	nonFileScriptIndices: Set<number>;
	scriptFilePaths: string[];
	unsafeInlineScript: boolean;
}

function isNonFileSedScript(script: string): boolean {
	if (!script.startsWith("/")) return false;

	let escaped = false;
	for (let index = 1; index < script.length; index++) {
		const character = script[index]!;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === "\\") {
			escaped = true;
			continue;
		}
		if (character === "/") {
			return /^[pPdDqQnNhHgGxbtl=;]*$/.test(script.slice(index + 1));
		}
	}
	return false;
}

export function classifySedOperands(
	tokens: readonly string[],
	sedIndex: number,
): SedOperandClassification {
	const nonFileScriptIndices = new Set<number>();
	const scriptFilePaths: string[] = [];
	let unsafeInlineScript = false;
	let cursor = sedIndex + 1;
	let optionsEnded = false;
	let expressionProvided = false;
	let scriptFileProvided = false;
	let expectsExpression = false;
	let expectsScriptFile = false;
	let positionalCount = 0;

	while (cursor < tokens.length) {
		const token = tokens[cursor];
		if (!token || SHELL_OPERATORS.has(token)) break;

		if (expectsExpression) {
			if (isNonFileSedScript(token)) nonFileScriptIndices.add(cursor);
			else if (token.startsWith("/")) unsafeInlineScript = true;
			expressionProvided = true;
			expectsExpression = false;
			cursor++;
			continue;
		}
		if (expectsScriptFile) {
			scriptFilePaths.push(token);
			scriptFileProvided = true;
			expectsScriptFile = false;
			cursor++;
			continue;
		}

		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			cursor++;
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token !== "-") {
			if (token === "-e" || token === "--expression") {
				expectsExpression = true;
				cursor++;
				continue;
			}
			if (token.startsWith("--expression=")) {
				const script = token.slice("--expression=".length);
				if (script.startsWith("/") && !isNonFileSedScript(script)) {
					unsafeInlineScript = true;
				}
				expressionProvided = true;
				cursor++;
				continue;
			}
			if (token === "-f" || token === "--file") {
				expectsScriptFile = true;
				cursor++;
				continue;
			}
			if (token.startsWith("--file=")) {
				scriptFilePaths.push(token.slice("--file=".length));
				scriptFileProvided = true;
				cursor++;
				continue;
			}
			if (token.startsWith("-e") && token.length > 2) {
				const script = token.slice(2);
				if (script.startsWith("/") && !isNonFileSedScript(script)) {
					unsafeInlineScript = true;
				}
				expressionProvided = true;
				cursor++;
				continue;
			}
			if (token.startsWith("-f") && token.length > 2) {
				scriptFilePaths.push(token.slice(2));
				scriptFileProvided = true;
				cursor++;
				continue;
			}

			const shortOptions = token.slice(1);
			if (shortOptions.includes("e")) {
				expectsExpression = true;
			} else if (shortOptions.includes("f")) {
				expectsScriptFile = true;
			}
			cursor++;
			continue;
		}

		if (!expressionProvided && !scriptFileProvided && positionalCount === 0) {
			if (isNonFileSedScript(token)) nonFileScriptIndices.add(cursor);
		}
		positionalCount++;
		cursor++;
	}

	return { nonFileScriptIndices, scriptFilePaths, unsafeInlineScript };
}
