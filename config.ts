/**
 * Configurazione dell'estensione "prevent-destructive-commands".
 *
 * Porting fedele del hook Claude `prevent-destructive-commands.py`:
 * tutte le liste nere e i flag di comportamento vivono qui, così è
 * sufficiente modificare questo singolo file per tarare la protezione.
 */

/**
 * Comandi che ricevono path come argomento: i loro target vengono
 * validati contro la working directory corrente.
 */
export const PATH_SENSITIVE_COMMANDS: ReadonlySet<string> = new Set([
	"rm",
	"unlink",
	"rmdir",
	"shred",
	"del",
	"erase",
]);

/**
 * Comandi che leggono contenuto di file: usati per rilevare accessi a
 * file sensibili (es. `.env`, chiavi SSH, credenziali).
 */
export const FILE_READING_COMMANDS: ReadonlySet<string> = new Set([
	"cat",
	"less",
	"more",
	"head",
	"tail",
	"grep",
	"egrep",
	"fgrep",
	"awk",
	"sed",
	"cut",
	"sort",
	"uniq",
	"xxd",
	"hexdump",
	"strings",
	"base64",
	"openssl",
	"jq",
	"yq",
	"bat",
	"tac",
	"nl",
	"od",
	"rev",
]);

/**
 * Pattern di nomi di file considerati sensibili. Il match è case-insensitive
 * e verifica sia `includes` che `endsWith`, come nel plugin Claude originale.
 */
export const SENSITIVE_FILE_PATTERNS: readonly string[] = [
	// Environment
	".env",
	".env.local",
	".env.production",
	".env.development",
	".env.test",
	".env.staging",
	".envrc",
	// Chiavi SSH
	"id_rsa",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa.pub",
	"id_dsa.pub",
	"id_ecdsa.pub",
	"id_ed25519.pub",
	"authorized_keys",
	"known_hosts",
	// Credenziali AWS
	"credentials",
	"config",
	// Credenziali database
	".pgpass",
	".my.cnf",
	".netrc",
	// Registry package
	".npmrc",
	".pypirc",
	"pip.conf",
	// Altri secret
	".htpasswd",
	"vault-password",
	"secret",
	"secrets",
	"secret.json",
	"secrets.json",
	"secret.yaml",
	"secrets.yaml",
	"secret.yml",
	"secrets.yml",
	// Chiavi private
	".key",
	".pem",
	".p12",
	".pfx",
	".pkcs12",
	"private_key",
	"private-key",
];

/**
 * Sotto-comandi AWS CLI distruttivi, confrontati come "<service> <operation>".
 */
export const AWS_DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set([
	"s3 rm",
	"s3 mv",
	"s3 rb",
	"s3api delete-object",
	"s3api delete-objects",
	"s3api delete-bucket",
	"ec2 terminate-instances",
	"ec2 delete-security-group",
	"ec2 delete-vpc",
	"ec2 delete-subnet",
	"ec2 delete-volume",
	"ec2 delete-snapshot",
	"ec2 delete-key-pair",
	"rds delete-db-instance",
	"rds delete-db-cluster",
	"rds delete-db-snapshot",
	"rds delete-db-cluster-snapshot",
	"rds delete-db-parameter-group",
	"rds delete-db-subnet-group",
	"rds delete-db-security-group",
	"rds delete-global-cluster",
	"dynamodb delete-table",
	"lambda delete-function",
	"lambda delete-alias",
	"lambda delete-event-source-mapping",
	"lambda delete-layer-version",
	"lambda delete-provisioned-concurrency-config",
	"lambda delete-function-concurrency",
	"lambda delete-function-url-config",
	"lambda delete-code-signing-config",
	"iam delete-user",
	"iam delete-role",
	"iam delete-policy",
	"cloudformation delete-stack",
	"cloudformation delete-stack-instances",
	"cloudformation delete-stack-set",
	"cloudformation delete-change-set",
	"eks delete-cluster",
	"ecs delete-cluster",
	"ecs delete-service",
	"secretsmanager delete-secret",
	"kms schedule-key-deletion",
	"kms disable-key",
	"sns delete-topic",
	"sqs delete-queue",
]);

/** Sotto-comandi Docker distruttivi nella forma legacy (`docker rm`). */
export const DOCKER_DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set(["rm", "rmi"]);

/** Sotto-comandi Docker distruttivi nella forma moderna (`docker container rm`). */
export const DOCKER_DESTRUCTIVE_COMPOUND: ReadonlySet<string> = new Set([
	"container rm",
	"image rm",
	"volume rm",
	"network rm",
	"container prune",
	"image prune",
	"volume prune",
	"network prune",
	"system prune",
	"builder prune",
	"compose down",
]);

/**
 * Comandi wrapper che delegano al comando reale nel token successivo
 * (es. `sudo rm`, `env -i rm`, `timeout 10 rm`). Vengono saltati nell'analisi.
 */
export const WRAPPER_COMMANDS: ReadonlySet<string> = new Set([
	"sudo",
	"env",
	"nice",
	"nohup",
	"timeout",
	"ionice",
	"time",
]);

/**
 * Comandi che eseguono come comando il primo argomento posizionale non-flag,
 * dato come stringa quotata da ritokenizzare (es. `watch "rm foo"`).
 */
export const QUOTED_COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
	"watch",
	"strace",
	"ltrace",
]);

/** Invocazioni di shell entro cui ricorrere per l'argomento `-c`. */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"zsh",
	"fish",
	"dash",
	"ksh",
]);

/** Comandi che pipeano i loro argomenti come nuovo comando. */
export const DELEGATION_COMMANDS: ReadonlySet<string> = new Set(["xargs", "parallel"]);

/** Flag di `find` che delegano esecuzione. */
export const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
]);

/**
 * Operatori di shell riconosciuti come token separatori dal tokenizer.
 * Devono restare allineati con `tokenizer.ts`.
 */
export const SHELL_OPERATORS: ReadonlySet<string> = new Set([
	"|",
	";",
	"&&",
	"||",
	"&",
	"(",
	")",
	"{",
	"}",
	">",
	"<",
	">>",
	"<<",
	"2>",
	"2>>",
]);

// ─── Flag di comportamento ───────────────────────────────────────────────────

/**
 * Se `true`, blocca anche `git add` e `git commit`.
 * Coerente con progetti in cui l'agente non deve creare commit in autonomia
 * (es. regola "no commits/push" del MES La Sportiva).
 */
export const ENABLE_GIT_ADD_COMMIT_BLOCK = true;

/**
 * Se `true`, blocca i comandi di lettura file (`cat`, `grep`, ...) quando
 * puntano a file sensibili (`.env`, chiavi SSH, credenziali).
 *
 * Disattivato di default: il substring matching del plugin originale è
 * molto rumoroso in un workflow di coding (es. "config" matcha tsconfig,
 * vite.config, next.config; ".env" matcha .environment.ts). Attivalo solo se
 * ti serve, sapendo dei falsi positivi, oppure affina i pattern qui sotto
 * (ad es. rimuovendo "config"/"secret" generici e tenendo solo le forme
 * con estensione).
 */
export const ENABLE_SENSITIVE_FILE_CHECK = false;

/** Profondità massima di nesting prima di considerare il comando offuscato. */
export const MAX_NESTING_DEPTH = 5;

// ─── Protezione path in scrittura ────────────────────────────────────────────

/**
 * Path (relativi alla working directory) protetti dalla scrittura: nessuno
 * strumento di scrittura (write/edit/apply_patch) né comando bash deve
 * modificarli, sovrascriverli o crearli. Pensati per asset immutabili come le
 * guardie SDD (docs/specs/guards). Il match è per prefisso normalizzato contro
 * il cwd: qualunque path che risolva sotto uno di questi viene bloccato.
 */
export const WRITE_PROTECTED_PATHS: readonly string[] = ["docs/specs/guards"];

/**
 * Se `true`, attiva la protezione in scrittura dei path in
 * WRITE_PROTECTED_PATHS sia per i tool di scrittura che per i comandi bash.
 */
export const ENABLE_WRITE_PROTECTION = true;

/**
 * Comandi bash che scrivono/sovrascrivono/modificano file: i loro argomenti
 * path vengono validati contro WRITE_PROTECTED_PATHS. Il controllo è su tutti
 * gli argomenti non-flag (conservativo: blocca anche se il path protetto è la
 * sorgente di una `cp`, per stare sul sicuro).
 */
export const WRITE_COMMANDS: ReadonlySet<string> = new Set([
	"cp",
	"mv",
	"install",
	"tee",
	"truncate",
	"dd",
	"chmod",
	"chown",
	"chgrp",
	"ln",
]);

/**
 * Operatori di redirect che scrivono su file: il token immediatamente
 * successivo è il path di destinazione e va protetto.
 */
export const WRITE_REDIRECT_OPERATORS: ReadonlySet<string> = new Set([
	">",
	">>",
	"2>",
	"2>>",
	"&>",
	"&>>",
]);
