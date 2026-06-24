# prevent-destructive-commands

Estensione [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) che
**blocca incondizionatamente** i comandi bash distruttivi prima dell'esecuzione.
Porting fedele dell'hook Claude `prevent-destructive-commands.py`.

## Installazione

L'estensione è in `~/.pi/agent/extensions/prevent-destructive-commands/` quindi viene
scoperta automaticamente da pi in tutti i progetti. Dopo aver modificato i file, usa
`/reload` per ricaricarla a caldo.

## Cosa blocca

Tutte le regole sono definite in [`config.ts`](./config.ts).

| Categoria | Esempi |
| --- | --- |
| **Git distruttivo** | `git reset --hard`, `git clean`, `git push --force` / `-f` / `--delete`, `git branch -D`, `git tag -d`, `git checkout -f`, `git rebase`, `git filter-branch`, `git filter-repo`, `git reflog expire`, `git update-ref -d` |
| **Git add/commit** | `git add`, `git commit` (vedi flag `ENABLE_GIT_ADD_COMMIT_BLOCK`) |
| **rm / path-sensitive** | `rm`/`rmdir`/`shred`/`unlink` su target **fuori** dalla working directory (es. `/etc`, `~`, `..`). I target dentro la cwd sono permessi |
| **Docker distruttivo** | `docker rm`/`rmi`, `docker container/image/volume/network rm`, `docker * prune`, `docker compose down -v`, `docker compose rm`, `docker context rm`, `docker swarm leave --force` |
| **AWS CLI distruttivo** | `aws s3 rm`, `aws ec2 terminate-instances`, `aws rds delete-db-instance`, `aws cloudformation delete-stack`, ecc. (lista completa in `config.ts`) |
| **Lettura file sensibili** | _Disattivato di default_ (`ENABLE_SENSITIVE_FILE_CHECK = false`). Quando attivo, blocca `cat`/`grep`/... su `.env`, chiavi SSH, `.pem`. Il substring matching originale è rumoroso in coding (`config` matcha `tsconfig`, `vite.config`), per questo parte spento |

L'analisi è **ricorsiva**: attraversa `sudo`/`env`/`timeout`, `bash -c "..."`, `find
-exec`, `xargs`/`parallel`, `watch`/`strace` e pipeline/concatenazioni (`|`, `&&`,
`;`) per non farsi sfuggire un comando distruttivo annidato.

### Limiti noti dell'analisi statica

Come il plugin Claude originale, l'analisi è statica e quindi non copre tutto:

- **Argomenti via stdin/pipe**: `echo x | xargs rm` non è bloccabile (gli argomenti di `rm` non sono visibili come token).
- **`cd` nel comando**: `cd /; rm etc/passwd` viene valutato contro il cwd di pi, non contro `/`. In pi l'agente raramente fa `cd` (il cwd è già il progetto), quindi il rischio è basso.
- **Sotto-comandi non in blacklist**: l'estensione copre i pattern noti; un wrapper sconosciuto o un tool custom distruttivo non viene intercettato.

## Comportamento

Hard block incondizionato: l'agente riceve solo il `reason` e deve cercare
un'alternativa. Non viene mai richiesta conferma interattiva, quindi il blocco vale
anche nelle modalità non interattive (`-p`, JSON, RPC).

## Configurazione

Modifica le costanti in [`config.ts`](./config.ts):

- `ENABLE_GIT_ADD_COMMIT_BLOCK` (default `true`) — blocca `git add`/`commit`.
  Metti `false` se vuoi permettere all'agente di creare commit.
- `ENABLE_SENSITIVE_FILE_CHECK` (default **`false`**) — blocca la lettura di file sensibili. Disattivato di default per via dei falsi positivi del substring matching (`config` → `tsconfig`, `vite.config`; `.env` → `.environment.ts`). Riattivalo solo se ti serve e considera di affinare `SENSITIVE_FILE_PATTERNS` (ad es. rimuovendo `config`/`secret` generici e tenendo solo le forme con estensione).
- Aggiungi/rimuovi pattern da `SENSITIVE_FILE_PATTERNS` o voci dai set di AWS/Docker.

Dopo ogni modifica: `/reload`.

## Struttura

```
prevent-destructive-commands/
├── index.ts       # factory + hook tool_call (entry point)
├── config.ts      # blacklists e flag di comportamento
├── tokenizer.ts   # tokenizer shell (shlex-like)
├── checker.ts     # analizzatore ricorsivo
└── README.md
```

## Verifica rapida

```bash
npx jiti ~/.pi/agent/extensions/prevent-destructive-commands/smoke-test.ts
```
