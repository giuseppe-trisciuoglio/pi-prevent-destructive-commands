/**
 * Configuration for the "prevent-destructive-commands" extension.
 *
 * Faithful port of the Claude hook `prevent-destructive-commands.py`:
 * all blacklists and behavior flags live here, so modifying this single
 * file is enough to tune the protection.
 */

// =============================================================================
// Command Categories
// =============================================================================

/**
 * Commands that receive paths as arguments: their targets are validated
 * against the current working directory.
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
 * Commands that read file content: used to detect access to sensitive
 * files (e.g., `.env`, SSH keys, credentials).
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
 * File name patterns considered sensitive. Matching is case-insensitive
 * and checks both `includes` and `endsWith`, as in the original Claude plugin.
 */
export const SENSITIVE_FILE_PATTERNS: readonly string[] = [
	// Environment files
	".env",
	".env.local",
	".env.production",
	".env.development",
	".env.test",
	".env.staging",
	".envrc",
	// SSH keys
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
	// AWS credentials
	"credentials",
	"config",
	// Database credentials
	".pgpass",
	".my.cnf",
	".netrc",
	// Package registry
	".npmrc",
	".pypirc",
	"pip.conf",
	// Other secrets
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
	// Private keys
	".key",
	".pem",
	".p12",
	".pfx",
	".pkcs12",
	"private_key",
	"private-key",
];

// =============================================================================
// AWS / Docker Destructive Operations
// =============================================================================

/**
 * Destructive AWS CLI subcommands, matched as "<service> <operation>".
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

/** Destructive Docker subcommands in legacy form (`docker rm`). */
export const DOCKER_DESTRUCTIVE_SUBCOMMANDS: ReadonlySet<string> = new Set(["rm", "rmi"]);

/** Destructive Docker subcommands in modern form (`docker container rm`). */
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
]);

// =============================================================================
// Wrapper / Delegation Commands
// =============================================================================

/**
 * Wrapper commands that delegate to the real command in the next token
 * (e.g., `sudo rm`, `env -i rm`, `timeout 10 rm`). These are skipped during analysis.
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
 * Commands that execute the first non-flag positional argument as a command,
 * given as a quoted string to be re-tokenized (e.g., `watch "rm foo"`).
 */
export const QUOTED_COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
	"watch",
	"strace",
	"ltrace",
]);

/** Shell invocations within which to recurse for the `-c` argument. */
export const SHELL_COMMANDS: ReadonlySet<string> = new Set([
	"bash",
	"sh",
	"zsh",
	"fish",
	"dash",
	"ksh",
]);

/** Commands that pipe their arguments as a new command. */
export const DELEGATION_COMMANDS: ReadonlySet<string> = new Set(["xargs", "parallel"]);

/** `find` flags that delegate execution. */
export const FIND_EXEC_FLAGS: ReadonlySet<string> = new Set([
	"-exec",
	"-execdir",
	"-ok",
	"-okdir",
]);

/**
 * Shell operators recognized as token separators by the tokenizer.
 * Must stay aligned with `tokenizer.ts`.
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

// =============================================================================
// Behavior Flags
// =============================================================================

/**
 * If `true`, also blocks `git add` and `git commit`.
 * Consistent with projects where the agent should not create commits autonomously.
 */
export const ENABLE_GIT_ADD_COMMIT_BLOCK = true;

/**
 * If `true`, blocks file reading commands (`cat`, `grep`, ...) when they
 * target sensitive files (`.env`, SSH keys, credentials).
 *
 * Disabled by default: the original plugin's substring matching is very noisy
 * in a coding workflow (e.g., "config" matches tsconfig, vite.config, next.config;
 * ".env" matches .environment.ts). Enable only if needed, aware of the false
 * positives, or refine the patterns below (e.g., remove generic "config"/"secret"
 * and keep only forms with extensions).
 */
export const ENABLE_SENSITIVE_FILE_CHECK = false;

/** Maximum nesting depth before considering the command obfuscated. */
export const MAX_NESTING_DEPTH = 5;
