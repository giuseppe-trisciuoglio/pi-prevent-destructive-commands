/**
 * Analizzatore ricorsivo di comandi distruttivi.
 *
 * Porting del `_check_tokens` del plugin Claude. Visita la lista di token
 * riconoscendo wrapper, invocazioni di shell, `find -exec`, `xargs`, e i
 * comandi pericolosi (git, docker, aws, path-sensitive, lettura file
 * sensibili). Restituisce il primo motivo di blocco trovato.
 */

import { isAbsolute, normalize, resolve } from "node:path";
import { homedir } from "node:os";
import { tokenize } from "./tokenizer";
import {
	AWS_DESTRUCTIVE_SUBCOMMANDS,
	DELEGATION_COMMANDS,
	DOCKER_DESTRUCTIVE_COMPOUND,
	DOCKER_DESTRUCTIVE_SUBCOMMANDS,
	ENABLE_GIT_ADD_COMMIT_BLOCK,
	ENABLE_SENSITIVE_FILE_CHECK,
	FILE_READING_COMMANDS,
	FIND_EXEC_FLAGS,
	MAX_NESTING_DEPTH,
	PATH_SENSITIVE_COMMANDS,
	QUOTED_COMMAND_WRAPPERS,
	SENSITIVE_FILE_PATTERNS,
	SHELL_COMMANDS,
	SHELL_OPERATORS,
	WRAPPER_COMMANDS,
} from "./config";

export interface CheckResult {
	dangerous: boolean;
	reason: string;
}

const SAFE: CheckResult = { dangerous: false, reason: "" };

function block(reason: string): CheckResult {
	return { dangerous: true, reason };
}

// ─── Path utilities ───────────────────────────────────────────────────────────

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return homedir() + p.slice(1);
	if (p.startsWith("~")) {
		const username = p.slice(1).split("/")[0];
		return `/home/${username}`;
	}
	return p;
}

/** `true` se il path contiene variabili/glob risolvibili solo a runtime. */
function hasUnresolvableParts(p: string): boolean {
	return /\$[{(]?|\*|\?|\[/.test(p) || p === "{}";
}

function resolvePath(p: string, cwd: string): string | null {
	const expanded = expandTilde(p);
	if (hasUnresolvableParts(expanded)) return null;
	if (isAbsolute(expanded)) return normalize(expanded);
	return normalize(resolve(cwd, expanded));
}

function isOutsideCwd(p: string, cwd: string): CheckResult {
	if (hasUnresolvableParts(p)) {
		return block(`variabile o glob irrisolvibile nel path: ${JSON.stringify(p)}`);
	}
	const resolved = resolvePath(p, cwd);
	if (resolved === null) {
		return block(`impossibile risolvere il path in sicurezza: ${JSON.stringify(p)}`);
	}
	const cwdRoot = cwd.replace(/\/+$/, "");
	const cwdPrefix = `${cwdRoot}/`;
	if (resolved === cwdRoot || `${resolved}/`.startsWith(cwdPrefix)) {
		return SAFE;
	}
	return block(
		`${JSON.stringify(resolved)} è fuori dalla working directory ${JSON.stringify(cwd)}`,
	);
}

// ─── Checker ricorsivo ────────────────────────────────────────────────────────

export function checkTokens(tokens: string[], cwd: string, depth = 0): CheckResult {
	if (depth > MAX_NESTING_DEPTH) {
		return block(
			"nesting dei comandi troppo profondo per analizzare in sicurezza (possibile offuscamento)",
		);
	}

	let i = 0;
	while (i < tokens.length) {
		const token = tokens[i];

		if (!token || SHELL_OPERATORS.has(token)) {
			i++;
			continue;
		}

		// Wrapper commands: sudo rm, env -i rm, timeout 10 rm, …
		if (WRAPPER_COMMANDS.has(token)) {
			i++;
			continue;
		}

		// Quoted-command wrappers: il primo argomento posizionale è un comando
		if (QUOTED_COMMAND_WRAPPERS.has(token)) {
			let j = i + 1;
			while (j < tokens.length) {
				const arg = tokens[j];
				if (!arg || SHELL_OPERATORS.has(arg)) break;
				if (arg.startsWith("-")) {
					j++;
					continue;
				}
				const r = checkTokens(tokenize(arg), cwd, depth + 1);
				if (r.dangerous) return r;
				break;
			}
			i++;
			continue;
		}

		// Shell invocations: bash -c "..."
		if (SHELL_COMMANDS.has(token)) {
			let j = i + 1;
			while (j < tokens.length) {
				if (tokens[j] === "-c" && j + 1 < tokens.length) {
					const r = checkTokens(tokenize(tokens[j + 1]), cwd, depth + 1);
					if (r.dangerous) return r;
					break;
				}
				if (tokens[j].startsWith("-")) {
					j++;
				} else {
					break;
				}
			}
			i++;
			continue;
		}

		// find -exec rm {} \;
		if (token === "find") {
			let j = i + 1;
			while (j < tokens.length) {
				if (FIND_EXEC_FLAGS.has(tokens[j]) && j + 1 < tokens.length) {
					let end = j + 2;
					while (end < tokens.length && !["\\;", "+", ";"].includes(tokens[end])) {
						end++;
					}
					const r = checkTokens(tokens.slice(j + 1, end), cwd, depth + 1);
					if (r.dangerous) return r;
				}
				j++;
			}
			i++;
			continue;
		}

		// xargs / parallel: delegano il comando seguente
		if (DELEGATION_COMMANDS.has(token)) {
			if (i + 1 < tokens.length) {
				const r = checkTokens(tokens.slice(i + 1), cwd, depth + 1);
				if (r.dangerous) return r;
			}
			i++;
			continue;
		}

		if (token === "aws") {
			const r = checkAws(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (token === "docker") {
			const r = checkDocker(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (token === "git") {
			const r = checkGit(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (FILE_READING_COMMANDS.has(token)) {
			const r = checkFileReading(tokens, i);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		if (PATH_SENSITIVE_COMMANDS.has(token)) {
			const r = checkPathSensitive(tokens, i, token, cwd);
			if (r.dangerous) return r;
			i++;
			continue;
		}

		i++;
	}

	return SAFE;
}

// ─── Handlers specifici ───────────────────────────────────────────────────────

function checkAws(tokens: string[], i: number): CheckResult {
	const parts: string[] = [];
	let j = i + 1;
	while (j < tokens.length && tokens[j].startsWith("--")) j++;
	while (j < tokens.length && !tokens[j].startsWith("-") && parts.length < 3) {
		parts.push(tokens[j]);
		j++;
	}
	for (let length = parts.length; length > 0; length--) {
		const sub = parts.slice(0, length).join(" ");
		if (AWS_DESTRUCTIVE_SUBCOMMANDS.has(sub)) {
			return block(`operazione AWS CLI distruttiva: aws ${sub}`);
		}
	}
	return SAFE;
}

function checkDocker(tokens: string[], i: number): CheckResult {
	if (i + 1 >= tokens.length) return SAFE;
	const sub1 = tokens[i + 1];
	const rest = tokens.slice(i + 2);

	if (i + 2 < tokens.length) {
		const compound = `${sub1} ${tokens[i + 2]}`;
		if (DOCKER_DESTRUCTIVE_COMPOUND.has(compound)) {
			return block(`operazione Docker distruttiva: docker ${compound}`);
		}
	}
	if (DOCKER_DESTRUCTIVE_SUBCOMMANDS.has(sub1)) {
		return block(`operazione Docker distruttiva: docker ${sub1}`);
	}
	if (sub1 === "compose" && i + 2 < tokens.length) {
		const composeSub = tokens[i + 2];
		if (composeSub === "down" && rest.includes("-v")) {
			return block("docker compose down -v rimuove i volume con rischio di perdita dati");
		}
		if (composeSub === "rm") {
			return block("docker compose rm rimuove i container fermati");
		}
	}
	if (sub1 === "context" && i + 2 < tokens.length && tokens[i + 2] === "rm") {
		return block("docker context rm rimuove i context Docker");
	}
	if (
		sub1 === "swarm" &&
		i + 2 < tokens.length &&
		tokens[i + 2] === "leave" &&
		rest.includes("--force")
	) {
		return block("docker swarm leave --force rimuove forzatamente il nodo dallo swarm");
	}
	return SAFE;
}

const GIT_GLOBAL_FLAGS_WITH_ARG: ReadonlySet<string> = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--work-tree",
	"--namespace",
	"--super-prefix",
	"--config-env",
	"--shallow-file",
	"--exec-path",
]);

/**
 * Trova il subcommand git reale, saltando i flag globali (con e senza
 * argomento) che possono comparire prima del subcommand, come `-C <path>`.
 * Restituisce l'indice del subcommand, oppure -1 se non c'è.
 */
function findGitSubcommandIndex(tokens: string[], start: number): number {
	let j = start + 1;
	while (j < tokens.length) {
		const t = tokens[j];
		if (!t || t === "--") return -1;
		if (GIT_GLOBAL_FLAGS_WITH_ARG.has(t)) {
			j += 2; // flag + argomento
			continue;
		}
		if (t.startsWith("-")) {
			j++;
			continue;
		}
		return j; // primo token non-flag = subcommand
	}
	return -1;
}

function checkGit(tokens: string[], i: number): CheckResult {
	const subIndex = findGitSubcommandIndex(tokens, i);
	if (subIndex === -1) return SAFE;
	const sub = tokens[subIndex];
	const rest = tokens.slice(subIndex + 1);

	if (sub === "reset" && rest.includes("--hard")) {
		return block("git reset --hard scarta tutte le modifiche locali");
	}
	if (sub === "clean" && !rest.includes("-n") && !rest.includes("--dry-run")) {
		return block("git clean rimuove file non tracciati (usa -n per un dry run prima)");
	}
	if (sub === "push") {
		if (rest.includes("--force") || rest.includes("-f")) {
			return block("git push --force sovrascrive la cronologia remota (distruttivo)");
		}
		if (rest.includes("--force-with-lease")) {
			return block("git push --force-with-lease può sovrascrivere la cronologia remota");
		}
		if (rest.includes("--delete")) {
			return block("git push --delete rimuove branch/tag remoti");
		}
	}
	if (sub === "branch" && rest.includes("-D")) {
		return block("git branch -D elimina forzatamente il branch senza controlli");
	}
	if (sub === "tag" && (rest.includes("-d") || rest.includes("--delete"))) {
		return block("git tag -d elimina il tag");
	}
	if (sub === "checkout" && (rest.includes("-f") || rest.includes("--force"))) {
		return block("git checkout -f scarta forzatamente le modifiche locali");
	}
	if (sub === "rebase") {
		return block("git rebase riscrive la cronologia dei commit (potenzialmente distruttivo)");
	}
	if (sub === "filter-branch" || sub === "filter-repo") {
		return block(`git ${sub} riscrive la cronologia del repository (altamente distruttivo)`);
	}
	if (sub === "reflog" && rest.includes("expire")) {
		return block("git reflog expire elimina i riferimenti di recupero");
	}
	if (sub === "update-ref" && (rest.includes("-d") || rest.includes("--delete"))) {
		return block("git update-ref -d elimina direttamente i riferimenti git");
	}
	if (ENABLE_GIT_ADD_COMMIT_BLOCK && sub === "add") {
		return block("git add stages le modifiche nell'indice");
	}
	if (ENABLE_GIT_ADD_COMMIT_BLOCK && sub === "commit") {
		return block("git commit crea nuovi commit nel repository");
	}
	return SAFE;
}

function checkFileReading(tokens: string[], i: number): CheckResult {
	if (!ENABLE_SENSITIVE_FILE_CHECK) return SAFE;
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		const argLower = arg.toLowerCase();
		for (const pattern of SENSITIVE_FILE_PATTERNS) {
			if (argLower.includes(pattern) || argLower.endsWith(pattern)) {
				return block(`tentativo di leggere un file sensibile: ${JSON.stringify(arg)}`);
			}
		}
		j++;
	}
	return SAFE;
}

function checkPathSensitive(
	tokens: string[],
	i: number,
	token: string,
	cwd: string,
): CheckResult {
	let j = i + 1;
	while (j < tokens.length) {
		const arg = tokens[j];
		if (!arg || SHELL_OPERATORS.has(arg)) break;
		if (arg === "--") {
			j++;
			continue;
		}
		if (arg.startsWith("-")) {
			j++;
			continue;
		}
		const r = isOutsideCwd(arg, cwd);
		if (r.dangerous) {
			return block(
				`${JSON.stringify(token)} bersaglia un path fuori dalla working directory — ${r.reason}`,
			);
		}
		j++;
	}
	return SAFE;
}
