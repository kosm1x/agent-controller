# Rulings 1–5 — work-in-progress handover (2026-10-03)

`main` was merged into this branch at `be6152e` (2026-10-03).

Branch `wip/rulings-1-5` carries the UNSHIPPED build of operator rulings 1–5 (ruled
2026-10-01, see `next-sessions-queue.md` §rulings). Nothing here is deployed; `main` and
the live service (`b402df9`) do not contain it. Delete this file when the work merges.

## State per ruling

| Ruling | What | State |
| --- | --- | --- |
| 1 | Expiry notice at the 5-minute confirmation TTL | re-audit PASS; should-fix round + batch_decompose ruling; audit S1–S3 `395e3c3` PASSED audit; its should-fix round `7cfb892`; combined audit 2026-10-03 done (fixes below) |
| 2 | Confirm at schedule creation when a high-risk tool is included | as ruling 1: `395e3c3` passed audit, should-fix `7cfb892`; combined audit 2026-10-03 done |
| 3 / 3a / 3b / 3c / 3d | Credential-style facts and project credentials hidden from the model, used by name (`$SECRET_<NAME>` in `shell_exec`, `{{SECRET_<NAME>}}` in `http_fetch` / browser tools); the old "refuse to store" code removed. Ruling 3d (2026-10-03, "Just real credentials. Everything must be accessible"): a `projects.credentials` entry is a secret only when `isCredentialFact` says so | Fix rounds 3–9 done (round 8 `47b0cee`, round 9 `3d1ef77`); the grep / file_edit / KB guessing-oracle residual (round 9 residuals) ACCEPTED by the operator 2026-10-03; combined audit 2026-10-03: B1 grep regression + should-fix 1–4 fixed (below); eval gate pending (see "Order to finish" 5) |
| 4 | Changed-files-only tests in `jarvis_test_run` / `vps_deploy` / `jarvis_dev action=pr` | Built, fix round done; combined audit 2026-10-03 done; its output lines are model-visible (eval gate) |
| 5 | Docker in the shell gate: reads + `docker exec supabase-db psql` only; follow-ups 5a–5e (2026-10-03) | SHIPS WITH RESIDUALS (operator ruling 2026-10-03, `ea8bad1`); the differential `scripts/validate-shell-gate-diff.ts --run` is still to be run by the operator on the VPS |
| 6 | Shell mount namespace | PARKED by the operator. Not in this branch. See `postmortem-2026-10-01-host-mount-leak.md`. Do not rebuild it here. |

## Ruling 3 fix round (answers audit round 2)

All coded with tests; typecheck 0; 13 scoped test files green (965 passed, 5 todo).

- Scrub also catches JSON-escaped forms (once and twice) of a value — `src/lib/secret-refs.ts`.
- Scrub runs BEFORE output truncation — `src/tools/builtin/shell.ts`, `src/tools/builtin/http.ts`.
- Error path: `scrubThrown` in `src/tools/registry.ts` (string throws; read-only `message`; untouched errors rethrown as the same object).
- ~~Every entry under a project's `credentials` field is a secret regardless of key name (`isProjectSecret`).~~ Reversed by ruling 3d (2026-10-03): `isProjectSecret` judges every field's entries by `isCredentialFact("projects", key, value)`; the classifier also matches the whole names `s2` and `session`.
- `shell_exec` with an unknown `$SECRET_<NAME>` is refused.
- Scrub at the writers: `pushToThread` (router), both memory backends' `retain`, JME `writeEpisodic`.
- Placeholder is JSON-safe (no quotes).
- Fixtures on this workstream's lines are synthetic and runtime-assembled.
- To review: `buildIndex` returns an empty index when the store tables do not exist ("no such table"); other errors still throw.

Still owed for ruling 3:

1. One hand mutant per fix (revert the fix, run the ONE covering test file, expect RED, restore exactly). 18 were planned: placeholder, JSON-escape scrub, scrub-before-cut (shell stdout, shell error path, http), error path ×2, credentials-field mask ×2, string-throw scrub, longest-first sort, `deleteProject` cache invalidation, bridge log scrub, unknown-reference refusal, the four writers.
2. A separate audit (not the implementer) — production path, persistence of resolved values, every reader of facts/projects, scrub escapes and truncation, error path, credentials field, unknown references, pasted credential in conversation/memory stores, public-repo fixtures.

## Audit round 3 fix round (answers audit round 3)

Typecheck 0; each fix has a test that went RED with the fix reverted (hand mutant,
restored exactly).

- B1a — read-side scrub, one seam per store: `hydrateThreadIfNeeded` (router, thread
  rows from `conversations`); `SqliteMemoryBackend.recall` (both branches, so the
  Hindsight fallbacks too); Hindsight `recall` results and `reflect` text; JME
  `queryMemory` facts and the consolidator transcript (`transcriptLine`, the read of
  `jme_turns`); `getEssentialFacts` (per row before the cut, and on a cache hit);
  `events/retrieval` snippets (briefing; conversation and task rows). The chat and
  background-agent task description (system prompt incl. the enrichment block) is
  scrubbed at submit, the scope re-run's rebuilt description too.
- B1b — `ensureCriticalDataPersisted` runs right after the tool-call read, before the
  JARVIS day-log line, `pushToThread`, the memory `retain` and the JME write.
- S2 — `autoPersistConversation` scrubs user text and response before the title, the
  topic path and the summary are built.
- S3 — `appendDayLog` scrubs before its 500-char cut; chat / background-agent task
  title and description are scrubbed at submit. JME preference-signal snippets are
  written from the scrubbed turn.
- S4 — nested values under `credentials` (and nested `urls`/`config` secrets) show
  their own `$SECRET_` name in `project_get` (`  key.sub: <placeholder>`) and in
  `saved_secrets` (`credentials.key.sub`).
- N1 — the tool seam scrubs non-string results without throwing: undefined / null /
  numbers pass through, a JSON-able object is scrubbed through its JSON text.
- N2 — `shell_exec` refuses any `${…SECRET_…}` form other than the bare
  `${SECRET_X}` (operators, `${#…}`, `${!…}`, unclosed brace). New model-visible
  refusal line (eval gate).

## Audit round 4 fix round (answers audit round 4)

Typecheck 0; each fix has a test that went RED with the fix reverted (47 hand mutants,
each restored exactly; scoped vitest 37 files / 1528 tests green).

- Structural — outbound scrub at the inference seam (`scrubOutboundText` /
  `scrubOutboundMessages` in `adapter.ts`, the one shared scrub). Two choke points:
  `queryClaudeSdk` (the only caller of the Agent SDK `query`; prompt and system prompt)
  and `callProvider` in `adapter-openai.ts` (the only function that reaches the
  OpenAI-compat / Anthropic HTTP APIs; every message of every role, text parts and
  tool-call arguments, on a copy). Inside an SDK turn: registry tool results
  (`wrapTool`), inline SDK tools (`buildMcpServer`) and the Stop-hook block reason
  (`scrubHookOutput`). Also covered: vision `describeImage`, `generateEmbeddings`
  (nothing is sent when the scrub fails), Jev `askJev`. A value never stored reaches
  the model as typed; a stored one is replaced wherever it appears (system prompt,
  history, current message, tool results). SDK resume: `persistSession: false` and no
  `resume` / `continue` anywhere, so the SDK subprocess only ever holds what passed the
  seam in that turn (its auto-compaction summarises already-scrubbed content).
- Failure policy, inside `scrubSecrets` for every consumer: a build error other than
  "no such table" uses the last good index (one `warn` per failure episode); with no
  last good index it throws (fail closed). Perf: 70 KB / 40 secrets ≈ 0.2 ms per request.
- Point fixes: B1-a `getThreadTurns` scrubs on read; B1-b the KB block and the
  stable / variable sections are scrubbed after the join; S1 `extractPattern` scrubs
  title, message and result (skips on a scrub failure); S2 `decompose` KB and day-log
  excerpts before the cut, critic `runRecallCheck`, briefing `construct` prompt; S3
  `events/retrieval` task and memory-item titles; S4 the tool seam returns the
  scrubbed JSON text when it no longer parses, never the original object.
- 3d-a — a nested leaf is secret when its own key OR any ancestor key is a credential
  name (`password: {prod, staging}`, `github_token: {value, scope}`, `api_keys: [v]`),
  in both the index (`projectEntries`) and the display (`projectEntryLeaves`). Container
  names (`oauth`, `auth`, `credentials`, `creds`, `credenciales`) are not ancestors, and
  the meta-suffix exemption holds, so `oauth.client_id` and `ftp.host` stay visible.
- 3d-b — `isCredentialFact` names, whole tokens: plural `keys` / `tokens` in final
  position (`api_keys`, `access_keys`, `apiKeys`, `tokens`; not `max_tokens`-style
  quantities, not `public_keys`), `authorization`, `privkey`, `appkey`, `nip`, `otp`,
  `totp`, `mfa`, `2fa`, `seed` (not `random_seed`), `mnemonic`, `recovery_codes`,
  `backup_codes`, `dsn`; value shape: a PEM private key of any type (not a public key or
  a certificate). Meta-suffix convention: the last-token exemption list gained
  `enabled`, `region`, `host`, `url`, `file` (`otp_enabled`, `nip_region`, `dsn_host`,
  `seed_url`, also `token_url`, `password_file`), which are visible by name and still
  judged by value.

## Fix round 5 (rulings 3c/3d) — commit 95f6f7e, NOT re-audited

- B1 secret-ancestor = last token names a secret VALUE (`isSecretValueName`, user-facts.ts); compound containers (db_credentials, basic_auth, google_oauth, smtp_auth, oauth_config, credenciales_ftp) show host/user/username/client_id/project_id/port, hide password/client_secret; `password:{…}` / `api_keys:[…]` stay hidden; index == display.
- B2a `user_fact_set` / `project_update`: a whole value equal to a placeholder, `{{SECRET_X}}` or `$SECRET_X` resolves to the stored value, only into a key/leaf that stays hidden (else refused); unknown name or placeholder inside other text → `{error}`.
- B2b `project_update` deep-merges nested objects; null deletes (`credentials:{ftp:{password:null}}` one key, `{ftp:null}` whole entry). Description first line changed → eval gate.
- S1 `gemini_upload` scrubs text-MIME bytes (UTF-8, latin1 fallback for text MIME; octet-stream only if valid UTF-8 without NUL) before upload; fails closed.
- S2/S3/S4 classifier: follower-gated otp/mfa/2fa/seed/authorization (+header), new exclusions, new names/value shapes, meta suffix exempt only when the value has the meta type.
- S5 `dirtySinceLastGood`: a build failure after a store write fails closed; TTL-only failure still uses last good; recovery logged once.
- S6 `spawnSandbox` scrubs `opts.input` host-side (strings + numeric leaves), envVars untouched; a2a outbound text scrubbed.
- Notes: capStableContent and stop-hook scrub before cutting; tool-call args JSON-aware incl. numbers; `SecretScrubUnavailableError` typed, not a breaker failure / provider metric in callProvider; queryClaudeSdk scrub before timer + abort listener; vision/embeddings/jev via `scrubOutboundText`.
- Every item has a test that went RED under a hand mutant (file restored byte-exact).

Residuals added by fix round 5: binary `gemini_upload` files (PDF/images/audio/video/Office) are sent as read, and the other Gemini tools' model-authored args remain outside the seam; `gemini_upload` octet-stream is treated as text only when valid UTF-8 without NUL, and non-UTF-8 text MIME is decoded latin1 (a multi-byte-encoded secret could slip); `authorization_header` is kept as a credential name; the a2a remote agent's reply is not scrubbed (only our outbound text is).

## Fix round 6 (answers audit round 6 = FAIL) — NOT re-audited

- B1 (3d false positives): `acceso/respaldo/recuperacion/seguridad` name a secret value only after `codigo(s)/clave(s)/frase(s)` (`credenciales_de_acceso.{usuario,host}` visible); a name whose only credential words are containers (auth/oauth/credential(s)/creds/credencial(es)) and whose last token is an identity token (user/username/usuario/login/email/correo/mail/id/account/host/port/domain/uri/url/scope/tenant/redirect/endpoint/server) is not a credential by name (value still judged by shape); `uri` = `url` meta.
- B2 (3c): `resolveRenderedPlaceholders` (secret-refs.ts) at the registry seam before `resolveSecretRefs`: file_write / file_edit / jarvis_file_write / jarvis_file_update / jarvis_files_batch_write content fields get the stored value back for each rendered placeholder; unknown name / generic / mangled / outside a content field → `{error}`; any other non-read-only tool (and shell_exec + template tools always) with a placeholder → `{error}` naming `$SECRET_<NOMBRE>` / `{{SECRET_<NOMBRE>}}`. user_fact_set / project_update keep their own resolution. New model-visible refusal strings → eval gate.
- B3: `scrubStructured` scrubs object keys.
- S1–S3 classifier: new meta suffixes with value types; exclusions; webhook value shapes; URL path secret run; strict host/path/word types.
- S4: `projectFieldProblem` — non-object `credentials/urls/config` and `__proto__/constructor/prototype` keys refused (`{error}` in project_update, TypeError in the db layer; the merge skips them). New refusal string → eval gate.
- S5: a null index build (no database) no longer clears `dirtySinceLastGood`.

Residuals added by fix round 6: a placeholder that replaced a URL-encoded or JSON-escaped form of a value is resolved back to the RAW value in a file write; `gdocs_write` / `gsheets_write` and other non-file writers refuse placeholders (no write-back resolution); a category made only of container words (`credentials`) still hides every fact in it; `*_id` / `*_key_id` values that are 32/40-char hex (e.g. a Google `private_key_id`) stay hidden; single-label hosts (`db`) under a credential `*_host` key are hidden.

## Fix round 7 (answers audit round 7 = FAIL) — NOT re-audited

Typecheck 0; 37 scoped test files green (1922 passed); 34 hand mutants, all RED (each restored, checked with cmp). The audit's probes (`cls.ts`, `probe-r7.test.ts`, `b3.test.ts`) are ported into `user-facts.test.ts`, `secret-refs.test.ts`, `jarvis-files-search.test.ts`, `readback-wiring.test.ts` and `google-docs.test.ts`.

- **B-1(a) scrub before the cut.** These readers now scrub the WHOLE text before any slice, preview, outline or cap:
  - `file_read` (`file.ts`)
  - `jarvis_file_read` (`jarvis-files.ts`; a failed scrub returns `{error}`)
  - `data_summarize`
  - `gdocs_read` (8000), `gsheets_read` (100 per cell), the slides reader (8000)
  - KB search (`jarvis-fs.ts searchFiles`): an FTS row that holds a stored value is kept only when every query token appears in the scrubbed content, title or path, and its snippet is cut from the scrubbed content. A LIKE row whose only hit is inside a value is dropped. This closes the row / no-row prefix and substring oracles.
- **B-1(b) payloads and evidence.**
  - `declareReadbackGate` runs `scrubStructured` on every payload.
  - Callers scrub before their own cut: `jarvis_file_update` `must_contain` (160), `gdocs_write` `snippet` / `written_text`, `gsheets_write` `capCells` (60 per cell).
  - Verifiers compare against the raw artifact and also its scrubbed form (`containsWritten`, and the sheet cell check). Evidence quotes go through `quote()` (scrub, then cut). `confirmedCheck` scrubs the read text before `confirmedMismatch` cuts the line at 120; if the scrub fails, the line is left out.
- **B-1(c) file_edit oracle.** `safeMatches` (`code-editing.ts`) ignores any match that starts inside, ends inside or lies inside a stored-value span (`secretSpans` in `secret-refs.ts`). Ignored candidates do not consume text. A match that covers a whole value still works. The occurrence count and `replace_all` both use the safe matches.
  - The optional guard (refuse write-back of a placeholder not seen in an earlier result) was **skipped**. `shell_exec` can already write `$SECRET_X` to any file and test its prefix, so the guard would not close the primitive. Scrub-before-cut in the readers is the fix.
- **B-2 classifier.**
  - (1) `session_id` / `acme_session_id` / `csrf_id` / `sid_id` are credentials (`CREDENTIAL_ID_RE`, checked before the meta step).
  - (2) The untyped identity early return (`CONTAINER_TOKEN_RE` / `IDENTITY_LAST_RE`) is gone. Identity tokens are typed meta suffixes now, in `metaValueMatches`:
    - user / usuario / login / account / cuenta: one token, no password mix, no secret run
    - email / correo / mail: e-mail
    - port / puerto: 1–5 digits
    - server / servidor: host
    - endpoint: host or URL
    - dominio: domain
    - redirect: URL
    - tenant / client: UUID, ID or word
    - nombre: name
    - telefono / phone: phone
- **B-3.** The adjective `clave` (`fechas_clave`, `clientes_clave`, `puntos_clave`, `nombre_clave`, `palabra_clave`) is not a credential when it follows a plural noun or a listed noun (`CLAVE_ADJ_BEFORE`). These stay credentials: determiners (`nuestras_claves`), `banco_clave`, `teams_clave`, `clave_wifi` / `api` / `acceso`.
- **B-4 encoded forms.** Each scrubbed form gets its own placeholder, tagged ` · forma URL|JSON|JSON2` (raw has no tag). `resolveRenderedPlaceholders` re-encodes the value into that form (`encodeSecretForm`). The registry scrubs JSON tool results structurally (`scrubResultText` → `scrubJsonText`), so a raw value inside a JSON field gets the raw placeholder and is not JSON-escaped on write-back.
- **Should-fix.**
  - Identity tokens are typed (see B-2). `clave_de_acceso_usuario = jdoe` is visible.
  - The `location` meta accepts a path.
  - These are visible: `pin_message`, `gym_pass` (and other pass lookbehinds), `receta_secreta` (and other secreto/secreta lookbehinds), `stripe_publishable_key`, and `pk_live_` / `pk_test_` values (the Stripe value pattern is now `[sr]k_`).
  - `resolveRenderedPlaceholders` inspects object keys. A placeholder in a key is refused: "un dato oculto solo puede ir en el contenido del archivo, no en el nombre de un campo."
  - In `scrubStructured`, two keys that scrub to the same text no longer overwrite each other: later ones get a ` (n)` suffix.

Deviations / extras beyond the brief:
- `webhook` / `webhooks` is a credential name, with `WHOLE_NAME_META` url typing (a URL with a secret path is hidden).
- `rate` was removed from the token-follower exclusion, so `token_rate` is judged by its `rate` value type.
- `(csrf|xsrf) id` was added.
- The FTS / LIKE filtering changes search results for rows that hold stored values.
- Line numbers and sizes in `file_read` / `jarvis_file_read` now refer to the scrubbed view (a multi-line value collapses into its placeholder).

Model-visible strings changed (eval gate owed, not run):
- the placeholder form tag
- the key-placeholder refusal
- the `jarvis_file_read` scrub `{error}`
- what the classifier shows and hides

Residuals added by fix round 7:
- Shell-based oracles remain (`shell_exec` with `$SECRET_X` can transform or test the value). This is the existing shell-transform residual.
- Readers outside the patched set can still cut before the registry's whole-value scrub: wordpress, gdrive, external MCP bridges, and the code-index signature cut (MC_DIR source only).
- The substring scrub of non-JSON text that embeds JSON tags by the serialized form (a value inside JSON quoted in prose gets a `forma JSON` placeholder).
- FTS rows without stored values keep SQLite's snippet.

## Rulings 1–2 should-fix round + batch_decompose ruling (2026-10-03)

Answers the rulings 1–2 re-audit (PASS with should-fix items) and the operator ruling of
2026-10-03 on `batch_decompose`. Typecheck 0; every item has a test that went RED with
the fix reverted (23 hand mutants, each restored byte-exact).

- API task creating a risky schedule: `noConfirmApiScheduleError` (no "resubmit with
  `interactive:false`" advice — that is refused too). `src/tools/task-executor.ts`.
- `confirmation.expired` trace event `{tool, notified, reason}` (reason `notified` /
  `already_decided` / `no_notifier` / `notify_failed`) at the one expiry decision
  (`lapsePendingConfirmation`), keyed by the task that showed the card.
- The expiry notice is sent through `sendLLMReplyToChannel` (deliverable filter), logged to
  the day-log, and pushed into the thread history as a Jarvis turn.
- Boot sweep `rearmPendingConfirmationsAtBoot` (called once from `messaging/index.ts` via
  `router.rearmPendingApprovals()`): one pass, newest 50 pending rows, one per chat. Past
  the TTL → lapse and notify at once; otherwise a timer for the remainder (unref'd, through
  `lapsePendingConfirmation`). Recipient from the thread key only (owner channel's own key,
  or a WhatsApp group key whose sender is the owner); otherwise a logged silent lapse
  (`no_notifier`). The rehydrate-on-read timer uses the same lapse path.
- Any unregistered tool name is risky at schedule creation (not only `server__tool`).
- Creation card: carriers and unregistered names marked "(puede usar cualquier
  herramienta)"; the risky list shows at most 5 names, then "y N más".
- Ruling 2026-10-03: a sub-task of a NON-interactive run (batch child, any depth) inherits
  the run's declared tool list (`inheritedDeclaredTools`, from the root's `tools`; a
  child's own `tools` does not widen it). A high-risk tool or carrier outside it is refused
  at the child's gate with `undeclaredToolError` (trace `tool.gated` /
  `refused_undeclared`). The dispatcher then fails the child (one status mapping, one
  completion ledger — no second "done" decision) and calls `recordRitualFailure` for the
  schedule/ritual the run serves (`schedule.run_failed`). Interactive/chat runs unchanged.

Residuals (to state at ship time):

- Unresolvable recipient after a restart (community mailbox, unknown key shape, channel not
  up) → the approval lapses silently (`no_notifier`, logged).
- Pending rows beyond the 50-row boot cap: re-armed only when the chat is next read (then
  through the same lapse path, with the notice when the recipient resolves). A row first
  read after its TTL is closed as expired silently — no notice, no trace.
- The thread-history entry for the notice is in memory only (not in `conversations`); it is
  lost on restart.
- A boot-swept or rehydrated card has no task id: its trace is keyed `approval:<id>`.
- A background run that declared no `tools` list leaves its children unrestricted.
- Read calls of a mixed tool (`google_workspace_cli` plain read, per
  `CONFIRMATION_PREDICATES`) are not "high-risk" and pass an undeclared check.
- The refused child fails; the parent background run itself still reports its own outcome
  (the schedule gets the `schedule.run_failed` alert from the child).

### Rulings 1–2 audit S1–S3 (`395e3c3`) + its should-fix round

`395e3c3` (S1 router notice bookkeeping best-effort; S2 openai path bounded by the run's
declared tool list, `[]` = no tools; S3 inherited declared list never dropped; notice
retries cancelled by a newer card / decision / clear) passed audit. Should-fix round:

- Notice retry race closed: a per-thread generation (`noticeGenerations`, bumped by
  `cancelNoticeRetries`) is captured before each attempt; a send that fails after a newer
  card / decision / clear landed mid-flight schedules no further attempt
  (`expiry_notice_failed` with `superseded: true`, then `confirmation.expired` reason
  `notice_superseded`; no `recordRitualFailure`).
- S2 drop of definitions outside the declared list now emits trace
  `tools.declared_filtered` `{declared, handed_in, kept, dropped}` on the run's task id
  (the console.warn stays).

Notes for ship time:

- **S2 is invisible to the eval gate.** The eval runner builds definitions with
  `toolRegistry.getDefinitions(...)` (`src/tuning/eval-runner.ts:42`) and calls outside any
  execution context, so `declaredToolSetForRun()` is `undefined` there and nothing is
  filtered. The cover is the unit test `src/inference/adapter-openai.declared-tools.test.ts`
  (declared-list cases + the trace), not `eval:gate`.
- **Residual (openai path):** a deferred tool outside the chat's scoped set no longer
  expands in the same run. Recovery is the scope re-run, as on the SDK path (whose
  `allowedTools` already admitted only the given names).
- **Operator read-only check before deploy, if running `INFERENCE_PRIMARY_PROVIDER=openai`:**
  `./mc-ctl db "SELECT schedule_id,name,delivery FROM scheduled_tasks WHERE tools='[]' AND active=1"`
  — any such schedule now runs with NO tools (before, `getDefinitions([])` gave it the full
  registry). Re-save it with its real list if it needs tools.

## Ruling 5 follow-ups (operator, 2026-10-03, asked one by one) — `6dc2358`, `97b051c`

- 5a psql shell escapes (`\!`, `\o |`, `COPY … PROGRAM`, `-f`, `| sh`): no gate change. OPERATOR STEP: give Jarvis's psql a non-superuser DB role. Residual until done.
- 5b `docker exec -e/--env` (all spellings, `-ie` clusters): only on `docker exec [opts] supabase-db psql …`, only `PG*` names (bare name = passthrough). Everything else, `--env-file`, and `-e` on any other exec form stay refused. Mutants ×3 RED.
- 5c lifecycle verbs stay allowed; `docker volume create` with `type=none` / `o=…bind…` / `device=` refused (comma-split continuation read; cap refuses). Mutants ×3 RED.
- 5d daemon redirection stays refused (`-H`/`--context`/`--config`, docker.sock); `DOCKER_ENV_ASSIGN_RE` widened to ANY `DOCKER_\w*=` assignment anywhere in the command (case-sensitive), not only before a docker word, because scripts/make/npm run/interpreters reach docker indirectly; a non-docker command setting a `DOCKER_` var is refused by design (`97b051c`, mutant RED).
- 5e differential: `npx tsx scripts/validate-shell-gate-diff.ts --run [--days 30] [--ref main]` — read-only (better-sqlite3 readonly + query_only), the ref's validator via `git archive` into a temp dir, redacted by default; exit 0 / 1 unexplained / 2 no commands found / 3 error. mc.db has no tool-args table, so it walks the JSON columns of runs/tasks/prometheus_snapshots/events plus tool_approvals; exit 2 on the VPS means a logging source is needed first.

Residuals (ruling 5, to state at ship time): psql escapes until the non-superuser role exists (5a); PG* vars can point libpq at container files (PGPASSFILE/PGSSLKEY/PGSERVICEFILE/PGSYSCONFDIR) and PGOPTIONS sets server options; volume options built at run time (`$(…)`, xargs from a file) and third-party volume drivers' host-path options are not seen by the string gate.

Operator ruling 2026-10-03: ship with residuals. Ruling 5 ships with the residuals above plus
these open classes, which the text gate does not close and is not expected to:

- (a) Bash ANSI-C quoted strings (`$'…'`) whose escape sequences spell a docker word or a
  `DOCKER_*` name; the text gate reads the command as written and does not decode them.
- (b) Environment loaded from a file — `.` / `source`, `BASH_ENV`, `ENV`, `set -a` before a
  sourced file — can set `DOCKER_*` variables that never appear in the command text.
- (c) The docker program name assembled at run time (printf, base64, an interpreter, a shell
  glob) is not seen by the text gate.
- (d) A writable `~/.docker/config.json` can set a current context, hence a daemon. Path-guard
  class; ruling 6 is parked.

`DOCKER_CONFIG` is now pinned inside `withPmShimPath`, so the task_gates `check_cmd` child gets
the same pin as `shell_exec` (it previously had none). The structural closer for (a)–(c) is an
exec-time docker shim in `src/tools/builtin/pm-shim/`, queued in `next-sessions-queue.md`
("Docker exec-time shim (ruling 5 structural closer)").

## Order to finish

0. Operator, before shipping: measure KB search cost on the live KB size. Since round 8
   `searchFiles` fetches up to `FTS_FETCH_CAP = 5000` FTS / LIKE rows per query and scrubs
   each value-holding row before the visible `LIMIT`; time a few typical
   `jarvis_file_search` queries (read-only) on the VPS and lower the cap if needed.

0. Before shipping, the operator runs a read-only census of key names (never values) in
   `user_facts.key` and the `projects.credentials` keys, including nested ones, to see
   which live entries change visibility under 3d / 3d-a / 3d-b.

1. Ruling 3 mutants → re-audit ruling 3.
2. ~~Re-audit ruling 5 (re-run its tests and the differential against `main`).~~ DONE with residuals — operator ruling 2026-10-03, ship with residuals (see the ruling 5 section).
3. Re-audit rulings 1–2.
4. Combined audit of rulings 1–5.
5. ONE paid `npm run eval:gate -- --run` on the final text; do not ship on FAIL. Model-visible strings changed by this work: the hidden-value placeholder, the unknown-reference refusal, the `${…SECRET_…}` expansion refusal, the nested-entry lines of `project_get` / `saved_secrets`, the ruling 3d `project_get` / `saved_secrets` change (non-secret `credentials` entries shown in clear and dropped from `saved_secrets`), `project_get` first description line, `project_update` first description line, the ruling 5 shell description lines, the ruling 4 coding-section wording and the ruling 4 output lines of `jarvis_test_run` / `vps_deploy` / `jarvis_dev action=pr` (changed-files-only test runs); the audit round 4 inference-seam scrub (stored values are replaced in the system prompt — KB, user facts, history, enrichment — wherever they appeared, and in every message and tool result); the 3d-a nested-leaf visibility and the 3d-b classifier changes (more names and PEM private keys hidden; `…_enabled/_region/_host/_url/_file` names visible); round 6 rendered-placeholder refusals and the `projectFieldProblem` refusal; round 7 placeholder form tag (` · forma URL|JSON|JSON2`), the key-placeholder refusal and the `jarvis_file_read` scrub `{error}`; round 8 classifier changes (`ciec`, `*_session`, `user:pass`, length meta) and the file_edit / KB scrubbed lengths; round 9 `OVERLAP_PLACEHOLDER` removed (older-wins rendering), `clave_<servicio>` inverted to a service allow-list, narrower `user:pass`, `*_session` token rule, KB ranking/size of value-holding rows, grep `truncated: true` on the per-file cap; combined audit 2026-10-03: the `http_fetch` description (by-name `{{SECRET_<NAME>}}` section; "sends no secrets" removed), the reworded rendered-placeholder refusal ("si tienes shell_exec … si tienes http_fetch o el navegador …"), grep `truncated: true` on the output byte cap, and the rendered-placeholder refusal now returned INSTEAD of a confirmation card for a high-risk call; rulings 1–2 should-fix round: `noConfirmApiScheduleError` (API task creating a risky schedule), `undeclaredToolError` (batch child refused), the creation-card suffix "(puede usar cualquier herramienta)" and "y N más", unregistered tool names now listed on the card, and the expiry notice now present in the thread history the model reads.
6. Docs (`PROJECT-STATUS.md`, `README.md` baselines, queue), merge to `main`, operator deploy.

## Rules that apply to this work

- Scoped vitest only (literal test-file paths); the pre-commit hook is the one full run. NOTE: the cloud clone used on 2026-10-03 has no pre-commit hook installed, so commits `bab59cf`…`2be88e1` have NOT had a full-suite run — run it once (VPS, or CI on the PR) before merge.
- No real credential, project slug, key name or e-mail in fixtures — this repo is public.
- Tests that need a database use a temp db with synthetic rows; the live `mc.db` is never written and no stored value is ever printed.
- No new dependencies, no schema change without `SCHEMA_MIGRATIONS`.
- Deploy is operator-only.

## Known residuals of ruling 3c (to state at ship time)

By-name use is not bound to a destination host; shell transforms of a value (base64, rev,
cut) are not scrubbed; values under 8 characters are not scrubbed; screenshots cannot be
scrubbed; the day-log line written when a message arrives precedes any save; cuts made
inside external MCP servers happen before the scrub; container runners cannot use by-name
references; a credential whose key name and value shape both escape the classifier (e.g. a
password stored under a neutral key such as `ftp` or `admin`, or nested below a container
name such as `oauth.ftp`) is shown and not scrubbed (ruling 3d; children of a
credential-named parent such as `passwords.ftp` are hidden since fix round 4).

Ruling 3d neutral-key gap, `user / pass` form (combined audit 2026-10-03): a login written
as a neutral-key value with the user and the password side by side, e.g. a fact
`[cuentas] netflix = demo@example.invalid / Xy7…` or `usuario pass`, is shown and not
scrubbed — the key names no credential and the value is not a single-token secret shape
(`looksLikeUserPass` only reads the `user:pass` form under a login-ish key). Same class as
the neutral-key gap above.

Added after audit round 3: partly percent-encoded URLs, `\uXXXX` JSON escapes,
the Playwright fill echo and `browser_evaluate` / `run_code` transforms escape the
scrub; template values are inserted raw (no URL or JSON encoding); the index can be
up to 60 s stale for out-of-process edits; a secret's name changes when a later entry
collides with it; by-name use is not bound to the sender or the channel;
`redactCredentials` rewrites part of the placeholder (cosmetic); persistence written
before the deploy stays in clear at rest, but is never sent to a model in clear (the model paths listed in the audit round 5 coverage table pass the inference seam; an operator backfill is optional); a
non-JSON-able object tool result (circular, BigInt) passes the tool seam unscrubbed.

Added after audit round 4: Hindsight's server-side reflect runs over memories stored
in clear (Hindsight is off by default); indirect shell expansions (`${!n…}`, `eval`)
fall under shell transforms; the confirmation continuation re-sends the raw
`originalRequest` (current-turn residual — the seam replaces a value stored by then,
not one still unsaved); a background agent cannot re-save a pasted value already
stored under another name (it sees the placeholder); on the SDK path a value stored
mid-turn stays in that turn's context (the next request is scrubbed); with the
database failing, the last good index misses values stored after it; FTS snippet cuts
or the critic's `[`/`]` match markers inside a value defeat the substring scrub; Gemini: see fix round 5 (text uploads now scrubbed); images are pixels.

## Open notes

- ~~`http_fetch` description still says the tool sends no secrets.~~ FIXED in the combined-audit round (description change → eval gate).
- ~~Ruling 5: start/stop-type docker commands … await operator confirmation.~~ ANSWERED 2026-10-03 (see the follow-ups section); remaining are the 5a operator step and the VPS differential run.
- ~~Rulings 1–2: the "no confirmation channel" error suggests `interactive:false`, which is now refused for risky `schedule_task`; background `batch_decompose` declaring high-risk tools is not refused.~~ RESOLVED 2026-10-03 (should-fix round + batch_decompose ruling, above).

## Fix round 8 (audit round 8 — ruling 3)

Round-8 re-audit FAILED with four blocking stored-value oracles and four should-fix
leaks. All eight are closed; 3c (write-back of a rendered placeholder) stays PASS.

### Blocking fixes

- **B-1 overlap scrub (`src/lib/secret-refs.ts`).** The scrub now works over a span
  UNION of every stored form's occurrences, not sequential per-value replacement. A
  model-stored value `ctx + V[0]` that overlaps the real value `V` by one boundary
  character used to be replaced first, leaving the rest of `V` in clear. `scrubMergedSpans`
  gathers occurrences, merges those that truly overlap (`r.start < last.end`), and renders:
  the cover value's placeholder when one occurrence spans the whole region (nesting —
  a longer stored value that contains a shorter one, which must read as one unit); the
  single shared placeholder when all occurrences carry it; otherwise the new
  `OVERLAP_PLACEHOLDER` ("…varios datos…cópialos por separado por nombre"), which
  `resolveRenderedPlaceholders` refuses on write-back (it carries the `[oculto ·` marker
  but not `RENDERED_PLACEHOLDER_RE`). `secretSpans` returns these merged spans, so
  `code-editing` / `code-search` share the same oracle-free boundary. Adjacent (touching,
  non-overlapping) values each keep their own placeholder.
- **B-2 grep oracle (`src/tools/builtin/code-search.ts`).** The rg/grep run is always
  `--line-number --max-count 2000` (internal cap `INTERNAL_MAXCOUNT = 2000`); the
  `--files-with-matches` / `--count` / `-l` / `-c` flags were removed so match/no-match/count
  can no longer be read per character. `safeMatchCount` takes spans on the raw line and
  drops any hit that cuts into a value span (`a < e && s < b && !(a <= s && e <= b)`); files,
  counts and content are derived from kept hits only, then each surviving line is scrubbed
  before the `maxResults` slice and `MAX_OUTPUT` cap.
- **B-3 KB search limit-before-filter (`src/db/jarvis-fs.ts`).** The FTS and LIKE paths bind
  a bounded `FTS_FETCH_CAP = 5000` instead of the visible `LIMIT`, filter out value-holding
  rows the token filter rejects, then `.slice(0, limit)`. Clean rows keep bm25 relevance;
  value-holding kept rows are appended, ordered by `path` (localeCompare) so row order never
  depends on the value. The LIMIT no longer ran before the filter, so presence/absence at a
  given `limit` is no longer an oracle.
- **B-4 `clave_<servicio>` (`src/db/user-facts.ts`).** A leading `clave_X` is a credential
  unless X is an identifier word: new alternative
  `` `(?<=^ )claves?(?= (?!(?:${CLAVE_ID_AFTER}) )[a-z0-9])` `` with an identifier allow-list
  (`interbancaria|elector|producto|catastral|rfc|curp|…`). `ciec` added as its own name;
  `fiel` is NOT added bare (only caught in forms like `clave_fiel` via the clave rule) to
  avoid shadowing the ordinary adjective.

### Should-fix

- `*_session` holding a secret-shaped value is hidden (`SESSION_LAST_RE` + `hasSecretShape`).
- A `user:pass` value is hidden (`looksLikeUserPass`: rejects PATH_LIKE values and a backslash
  in the password part; password ≥ 6 chars, not all digits, no `:/\s`, and needs a special
  char / secret run / length-≥10 password mix).
- `length|len|size|count|longitud|tamano` are numeric meta suffixes (`CREDENTIAL_META_LAST_RE`,
  typed as `/^\d+$/` in `metaValueMatches`).
- `file_edit` (`src/tools/builtin/code-editing.ts`) reports `file_length` / `old_length` /
  `new_length` of the SCRUBBED view; the gdoc readback evidence
  (`src/lib/v8-4/readback-verifiers.ts`, `verifyDocWrite`) reports `norm(scrubSecrets(text)).length`.

### Deviations from the brief

- B-2 uses a per-line NUL-parse (`parseLineRecords`) + JS re-count rather than rg `--json`:
  no new dependency on rg's JSON event schema, and the fail-closed denylist check already lived
  in the per-line path.
- Internal max-count is 2000 and the KB fetch cap is 5000 (bounded, not unbounded).
- FTS value-holding rows are placed AFTER clean rows and sorted by path; adjacent (touching)
  value spans are NOT merged; a region fully covered by one occurrence renders the cover's
  placeholder (nesting), not `OVERLAP_PLACEHOLDER`.
- Extra identifier words were added to `CLAVE_ID_AFTER` beyond the brief's examples; `fiel`
  is not a bare name.
- The KB readback verifier's `file.content.length` (`readback-verifiers.ts` ~174) was left
  unchanged — that length is of a KB row the operator owns, not a scrubbed-doc view.
- Optional gdoc scrubbed-length regression test WAS added (the jarvis-fs mock now spreads the
  real module so `initDatabase`'s `seedDirectives` survives while `getFile` stays mocked).

### Residuals (unchanged scope)

- The pre-existing `code-search` test "a glob with a directory part narrows…" still fails;
  confirmed to fail identically on clean HEAD, not chased, not made worse.
- All round-3 through round-7 residuals above still stand (encoded-form edge cases, MCP-internal
  transforms, container runners, index staleness, the ruling-3d neutral-key/value-shape gap).

### Model-visible strings changed → eval gate owed

- New `OVERLAP_PLACEHOLDER` string surfaced to the model in scrubbed output.
- Classifier regex changes in `user-facts.ts` (leading-clave, `ciec`, session, user:pass,
  length meta). Per CLAUDE.md, run `npm run eval:gate -- --run` before shipping; not run here
  (do not ship on FAIL).

### Mutant verification (one per fix, revert → RED → restore → cmp)

| Fix | Mutant | Test file | Result |
| --- | --- | --- | --- |
| B-1 | partial overlap renders first placeholder, not OVERLAP | secret-refs.test.ts | RED, restored |
| B-2 | drop the `cuts()` guard in safeMatchCount | code-search.test.ts | RED, restored |
| B-3 | bind `limit` instead of FTS_FETCH_CAP in FTS SQL | jarvis-fs.test.ts | RED, restored |
| B-4 | remove the leading `clave_X` alternative | user-facts.test.ts | RED, restored |
| session | disable the `*_session` clause | user-facts.test.ts | RED, restored |
| user:pass | disable `looksLikeUserPass` | user-facts.test.ts | RED, restored |
| length meta | drop `length|len|size|count|…` from meta regex | user-facts.test.ts | RED, restored |
| file_edit len | old/new_length back to raw `.length` | secret-refs.test.ts | RED, restored |
| gdoc len | shownLen back to `norm(text).length` | readback-verifiers.test.ts | RED, restored |

## Fix round 9 (audit round 9 — ruling 3)

Round-9 audit FAILED with three blocking findings (B1 overlap rendering, B2/B3
ruling-3d regressions) and six should-fix items. All are addressed below;
NOT re-audited.

### Blocking fixes

- **B1 older-wins, un-merged spans (`src/lib/secret-refs.ts`, `scrubSpans`).** Round 8's
  span union with `OVERLAP_PLACEHOLDER` made the rendering depend on whether a
  later-stored value partially overlapping V occurred in the text. Now each value text has
  a WRITE ORDER (`firstSeen`: per-database `WeakMap`, keyed by sha256 of the text, order =
  the row's `updated_at` at first sight + a process-wide counter; facts by `id`, projects by
  `rowid`; no schema change). Occurrences are accepted oldest first: no overlap → kept;
  inside a kept span → dropped (nesting); fully containing every kept span it touches →
  replaces them (cover); PARTIAL overlap with an older kept span → dropped entirely. Spans
  never grow past their own occurrence, so context stays visible. Same-form self-overlaps
  of one value are joined. `OVERLAP_PLACEHOLDER` is removed (any leftover marker text is
  still refused on write-back by the generic `[oculto ·` check). `secretSpans` returns
  the same spans, so `file_edit` (`safeMatches`) and `grep` (`safeMatchCount`) share them;
  doc comments rewritten. A value keeps its first-seen order when re-saved by name, copied
  to another key (original deleted), or when a sibling field of its project row changes.
- **B2 `clave_X` inverted (`src/db/user-facts.ts`).** `CLAVE_ID_AFTER` is gone. A leading
  `clave_X` / `clave de X` is a credential name only when X is in `CLAVE_SERVICE_AFTER`
  (ftp, sftp, ciec, fiel, banco, correo, email, gmail, wifi, ssh, hosting, cpanel, bd/db,
  admin, root, servidor, wordpress, instagram, facebook, tarjeta, acceso, api, secreta,
  privada, portal, sistema, red, router, vpn, …); `sat` only as the LAST token
  (`clave_sat` hidden, `clave_sat_producto` visible). Any other leading `clave_X` is hidden
  only when its value is password-shaped (`LEADING_CLAVE_RE` + `looksLikePassword`:
  one token, ≥ 6 chars, password mix, secret run, or a special char beside letters and
  digits). `bancaria`, `cuenta`, `usuario` are NOT service words.
- **B3 `user:pass` narrowed.** `looksLikeUserPass` runs only when the key or category has a
  login/credential-ish token (`USERPASS_KEY_RE`: login, acceso, cuenta, account, ftp, ssh,
  admin, root, panel, cpanel, wp, wordpress, hosting, servidor, db, vpn, correo, usuario,
  auth, credenciales, …) and the password part carries a real signal (`hasPasswordSignal`:
  a special char other than `-` `_` `.`, or a secret run; the length-≥10 mix clause is gone).

### Should-fix

1. `*_session`: `looksLikeSessionToken` = secret run, or one whitespace-free token ≥ 16 chars
   (`training_session = Monday 9am` visible). The whole-name `session` rule (ruling 3d) is unchanged.
2. KB ranking (`src/db/jarvis-fs.ts`): every FTS row gets a score = query-token hits in its
   scrubbed content + title; clean rows keep bm25 order and value-holding rows (sorted by
   score, then path) are merged in before the first clean row with a lower score.
3. KB `size` of a value-holding row = scrubbed length (FTS and LIKE paths); `verifyKbFile`
   evidence reports the scrubbed length (`src/lib/v8-4/readback-verifiers.ts`).
4. KB 5000 fetch cap: documented as a residual at `FTS_FETCH_CAP`.
5. grep: `truncated: true` when any file reaches `INTERNAL_MAXCOUNT` (also on the no-match
   return). The description already says "count" = number of matches, which is what it
   reports (occurrences) — no description change.
6. Doc comments updated (scrubSecrets, scrubSpans, secretSpans, clave/user:pass/session).

### Deviations from the brief

- The write order is not a raw rowid/updated_at read on every build: it is fixed the first
  time a value text is seen in the process (`firstSeen`), so a by-name re-save, a copy, or a
  project-row bump cannot make a stored value "newer". Seeded from `updated_at`.
- Prettier was not run on the touched files (they were already non-conforming at HEAD).
- No `npm run eval:gate` run (classifier changes are model-visible through what is hidden; owed).

### Residuals (new in round 9)

- After a restart, orders are re-derived from row timestamps; project leaves share the
  project row's `updated_at`, so a sibling-field update before a restart makes a project
  value look as new as that update.
- A value stored AFTER another one that it legitimately overlaps in some text loses the
  overlap: its part outside the older span is shown there.
- grep's per-file cap (2000 raw matching lines) counts a line whose only hit is inside a
  value, so for a file with ~2000 matching lines the cut point / `total` can move by one.
- bm25 corpus statistics (FTS) include value-holding rows' raw text; clean-row order can in
  principle shift with them. KB search over > 5000 matching rows cuts in bm25 order before
  the filter.
- `verifyKbFile` evidence still carries `sha8` of the raw row content (unchanged).

### Model-visible strings changed → eval gate owed

- `OVERLAP_PLACEHOLDER` removed; classifier changes (clave_X, user:pass, session) change
  which stored facts are shown in clear.

### Mutant verification (revert → RED → restore → cmp)

| Fix | Mutant | Test file | Result |
| --- | --- | --- | --- |
| B1 | sort newest-first (newer wins) | secret-refs.test.ts | RED (4), restored |
| B1 | partial overlap merges into a union span | secret-refs.test.ts | RED (4 incl. the tool byte-identity test), restored |
| B1 | no first-seen carry | secret-refs.test.ts | RED (1), restored |
| B2 | any leading `clave_X` is a credential name | user-facts.test.ts | RED (31), restored |
| B3 | old loose password signal | user-facts.test.ts | RED (1), restored |
| B3 | no key gate | user-facts.test.ts | RED (1), restored |
| SF1 | session = secret run or mix | user-facts.test.ts | RED (2), restored |
| SF2 | append value rows after clean rows | jarvis-fs.test.ts | RED (1), restored |
| SF3 | FTS `size: r.size` / LIKE `size: r.size` | jarvis-fs.test.ts | RED (1 each), restored |
| SF3 | KB verifier raw length | readback-verifiers.test.ts | RED (1), restored |
| SF5 | drop `|| capped` | code-search.test.ts | RED (1 + pre-existing), restored |

## Combined audit fix round (2026-10-03, rulings 1–5)

Typecheck 0; every fix has a test that went RED under a hand mutant (restored, `cmp`).

- **B1 grep regression (ruling 3c).** `code-search.ts`: rg / grep run through `runCapped`
  (`spawn`, stdout streamed under a fixed 64 MiB byte cap, cut after the last complete
  line). A cap hit returns what was read with `truncated: true` and never re-runs grep;
  rg exit 1 = no matches; other rg failures (missing binary, error) still fall back to
  grep; a grep failure / timeout is an `{error}`. Round 8/9 span filtering unchanged.
- **SF1** `http_fetch` description: "sends no secrets" removed; new STORED CREDENTIALS
  section (`{{SECRET_<NAME>}}` in url / header / body, substituted at execution, never
  shown). `DO NOT USE WHEN:` names only registered tools. Under the 1500-char cap.
- **SF2** trace events: `tool.secret_ref_refused` `{tool, reason, stage}` (reason
  `rendered_placeholder` / `unknown_name` / `shell_expansion`; stage `execute` at the
  registry seam, `pre_gate` before a confirmation card) and `inference.scrub_unavailable`
  `{where: openai | claude_sdk | claude_sdk_tool_error}` (`src/lib/secret-ref-trace.ts`,
  keyed by the execution context's task id, else the run-tool context's; nothing outside
  a run). `resolveSecretRefs` refusals now carry a `reason`.
- **SF3** placeholder check before the card: `placeholderRefusalBeforeGate`
  (`task-executor.ts`) runs `resolveRenderedPlaceholders` when the gate would ASK, in the
  per-task executor and in `gateSdkToolCall`; the refusal is returned instead of
  `CONFIRMATION_REQUIRED` (no pending action, no gated-call record).
- **SF4** the rendered-placeholder refusal says "si tienes shell_exec … si tienes
  http_fetch o el navegador …; si no tienes ninguna de ellas, el valor no se puede usar en
  esta tarea (díselo al usuario)". The placeholder itself is unchanged.
- CI pin (`safety-invariants.test.ts`): `wrapTool`'s catch scrub moved into
  `scrubToolErrorText(err)`; same behaviour (outbound scrub, fallback text when the index
  is unavailable, now also traced).

Residuals:

- The placeholder text still names `shell_exec` / `http_fetch`; a run without those tools
  is told so only by the refusal (SF4).
- The pre-gate check judges the call as non-read-only (it only runs for a call the gate
  would ask about); gate refusals (cannot ask, undeclared tool) keep precedence over the
  placeholder refusal.
- grep: a run that hits the 64 MiB cap shows the first part of the tree only (rg order);
  a timeout of rg still falls back to grep (as before).
- `claude_sdk_tool_error` trace has no dedicated test.

Mutants: B1 cap→fallback/error (RED), B1 cap back to 2 MiB (RED ×2); SF2 registry trace
removed, openai trace removed, SDK trace removed (each RED); SF3 executor pre-check
removed, SDK pre-check removed (each RED).
