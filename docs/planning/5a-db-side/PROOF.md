# Ruling 5a option (b), DB-side half: proof on throwaway container (2026-10-19, 20:13-20:19 UTC)

Image `supabase/postgres:15.8.1.085`, container `scratch-pg-5a`, `--network none`, no published ports, no
volumes (PGDATA = a bind of a scratch dir, removed afterwards). Command = the live compose command
(`postgres -c listen_addresses=* -c wal_level=logical -c max_wal_senders=10 -c max_replication_slots=10
-c shared_preload_libraries=pg_cron,pg_net -c cron.database_name=postgres`), `/docker-entrypoint-initdb.d`
= empty dir (as live), healthcheck = live form `pg_isready -U supabase_admin -h localhost` (2 s interval).
Roles created on the scratch cluster: `postgres` (SUPERUSER, synthetic pw), `mcp_readonly` (synthetic pw),
`longevidad_ro`, `t5a_ro` (synthetic pw); extensions pg_cron, pg_net. Synthetic passwords were generated
with `openssl rand -hex 16`, passed only via `-e PGPASSWORD`, never echoed, shredded at the end; the
logs were scanned for every value (0 hits). Full raw output: `run-S.log`, `run-SL-default-cron.log`,
`run-SL-bgw.log`; probe script `probe5a.sh`.

## 0. Recon finding that changes the recipe

The live server does NOT read `/etc/postgresql/pg_hba.conf` or `/etc/postgresql/pg_ident.conf`.
The compose `command:` replaces the image CMD (`postgres -D /etc/postgresql`), so the server runs with
`config_file=/var/lib/postgresql/data/postgresql.conf`, `hba_file=/var/lib/postgresql/data/pg_hba.conf`.

Evidence:
- `docker image inspect supabase/postgres:15.8.1.085 --format '{{json .Config.Cmd}}'` → `["postgres","-D","/etc/postgresql"]`
- live `postmaster.opts` → `/usr/bin/postgres "-c" "listen_addresses=*" ... "-c" "cron.database_name=postgres"` (no `-D /etc/postgresql`, no `config_file`)
- live `$PGDATA/postgresql.conf` / `postgresql.auto.conf`: no `hba_file`/`ident_file`/`include` lines
- live in-use `$PGDATA/pg_hba.conf` rules: `local all all trust` · `host all all 127.0.0.1/32 trust` · `host all all ::1/128 trust` · `local replication all trust` · `host replication all 127.0.0.1/32 trust` · `host replication all ::1/128 trust` · `host all all all scram-sha-256`. In-use `$PGDATA/pg_ident.conf`: no maps.
- so today the socket is TRUST for every role (not peer): `docker exec supabase-db psql -U mcp_readonly ...` ran with no password in this session; any role incl. postgres/supabase_admin works the same way.
- scratch C1 (live command + strict file bind-mounted over `/etc/postgresql/pg_hba.conf`):
  `docker exec scratch-pg-5a psql -U postgres -At -c 'select 1'` → `1` [exit 0]; `show hba_file` → `/var/lib/postgresql/data/pg_hba.conf`; `show cron.host` → `localhost`; `show cron.use_background_workers` → `off`; `show max_worker_processes` → `8`.
  ⇒ mounting files over `/etc/postgresql/*` has NO effect on this deployment.

The proven mechanism instead: add `-c hba_file=/etc/postgresql-5a/pg_hba.conf` to the command and bind
the directory `/etc/postgresql-5a` read-only (variant files below), or edit `$PGDATA/pg_hba.conf` in place
and SIGHUP (section 4).

## 1. What inside the container needs a passwordless path

| Consumer | Role | Path | Needs passwordless? | Evidence |
|---|---|---|---|---|
| entrypoint, subsequent boot | — | none | no | `docker-entrypoint.sh` `_main`: DATABASE_ALREADY_EXISTS → prints "Skipping initialization", `exec postgres`; no psql |
| entrypoint, first init | supabase_admin | socket (temp server, `listen_addresses=''`) | observed not to matter (strict file from first boot completed init, section 3) | live init dir is empty, so only `docker_setup_db` runs |
| healthcheck `pg_isready -U supabase_admin -h localhost` | — | loopback | no: pg_isready does not authenticate | (f) passes under both variants, FailingStreak 0 |
| pg_cron, `cron.use_background_workers=off` (default) | job owner | libpq TCP to `cron.host=localhost` | YES | SL-default-cron: job `failed=1`, return_message `connection failed` |
| pg_cron, `cron.use_background_workers=on` | job owner | background worker (no hba) | no | SL-bgw: job `succeeded=1` |
| pg_cron launcher, pg_net 0.14.0 worker | supabase_admin | background worker (no hba) | no | rev 2 run (`run-SL-bgw-peer.log`, §6): `pg_stat_activity` lists `pg_cron launcher as supabase_admin` and `pg_net 0.14.0 worker as supabase_admin`, `/proc` cmdlines show both; `net.http_get` queue 0→1→0 within 6 s and 1 `_http_response` row (status_code null, error "Couldn't connect to server" = network none). (The rev-1 `run-SL-bgw.log` bgw block was truncated to 4 rows by the probe helper and shows neither worker; an unlogged ad-hoc rev-1 run showed both.) |
| host jobs (cron / timers / operator scripts) | postgres, supabase_admin | socket via `docker exec` as root | YES under rev 1 (they all break) → rev 2 peer route for OS user postgres | §6 + APPLY "Host consumers" |
| supautils | — | not loaded on live | — | `session_preload_libraries='supautils'` is only in the unused `/etc/postgresql/postgresql.conf` |
| other Supabase containers + host clients via 127.0.0.1:5433 | various | TCP from 172.20.0.x | no (already scram) | live `/proc/net/tcp` ESTABLISHED to :5432: 172.20.0.8 ×9, 172.20.0.3 ×1, 172.20.0.9 ×1; none from 127.0.0.1/::1 |
| Jarvis gate path `docker exec supabase-db psql -U mcp_readonly` | mcp_readonly | socket | YES today (no `-e PGPASSWORD` in use; no SECRET_ for it in `src/`) | kept as `trust` for the two RO roles only |

Live cron: `cron.job` n_live_tup = 0, `cron.job_run_details` n_live_tup = 0 (via `pg_stat_all_tables`;
`SELECT count(*) FROM cron.job` as mcp_readonly → `permission denied for schema cron`).

## 2. Probe matrix (initialized cluster, `-c hba_file=/etc/postgresql-5a/pg_hba.conf`)

S = `pg_hba.conf.socket-only`; SL = `pg_hba.conf.socket-and-loopback`; SL+bgw adds `-c cron.use_background_workers=on`.
"refused" = `psql: error: ... fe_sendauth: no password supplied` [exit 2].

| Probe | Command | S | SL (default cron) | SL+bgw |
|---|---|---|---|---|
| (a) boot → healthy | poll `.State.Health.Status` | healthy 2.2 s | healthy 2.2 s | healthy 2.1 s |
| (b) | `docker exec scratch-pg-5a psql -U postgres -c 'select 1'` | refused | refused | refused |
| (b2) | `... psql -U supabase_admin -d postgres -c 'select 1'` | refused | refused | refused |
| (c) | `docker exec -u postgres scratch-pg-5a psql -U postgres -c 'select 1'` | refused (no peer line kept) | refused | refused |
| (d) | `... psql -h 127.0.0.1 -U postgres -c 'select 1'` | **1 (passwordless)** | refused | refused |
| (d6) | `... psql -h ::1 -U postgres` | **1** | refused | refused |
| (e) | `... psql -h 127.0.0.1 -U supabase_admin -d postgres` | **1** | refused | refused |
| (e2) | `... psql -h localhost -U postgres` | **1** | refused | refused |
| (f) | `pg_isready -U supabase_admin -h localhost` + Health | accepting, healthy, streak 0 | same | same |
| (h1) | `-e PGPASSWORD psql -U t5a_ro -h 127.0.0.1` (scram) | t5a_ro | t5a_ro | t5a_ro |
| (h2) | `-e PGPASSWORD psql -U t5a_ro` (socket, scram) | t5a_ro | t5a_ro | t5a_ro |
| (h3) | `psql -U t5a_ro` (socket, no pw) | refused | refused | refused |
| (h4) | `psql -U mcp_readonly -d postgres` (socket, no pw = Jarvis today) | mcp_readonly | mcp_readonly | mcp_readonly |
| (h5) | `-e PGPASSWORD psql -U mcp_readonly -h 127.0.0.1` (scram) | mcp_readonly | mcp_readonly | mcp_readonly |
| (h6) | `-e PGPASSWORD psql -U postgres` (socket, superuser with pw) | postgres | postgres | postgres |
| (g) | `cron.schedule('t5a','* * * * *',$$SELECT 1$$)` as postgres, read `cron.job_run_details` | succeeded=1 (~55 s) | **failed=1, "connection failed"** | succeeded=1 (~45 s) |
| (i) | `docker restart`, then (a),(b),(d),(h4) | healthy 2.3 s; (b) refused; (d) 1; (h4) ok | healthy 2.2 s; refused; refused; ok | healthy 2.3 s; refused; refused; ok |

Verdict: S viable; SL viable ONLY with `-c cron.use_background_workers=on`; SL without it breaks every pg_cron job.

## 3. First boot vs initialized cluster

- Strict SL file via `-c hba_file` from FIRST boot on an empty data dir (empty init dir): init completed
  ("PostgreSQL init process complete"), healthy in 3 s, `show hba_file` → `/etc/postgresql-5a/pg_hba.conf`.
  Not traced why `docker_setup_db`'s `psql --no-password` as supabase_admin passed; with Supabase's own
  init scripts (not mounted on live) this is unproven.
- Initialized cluster: proven for S, SL, SL+bgw (section 2), incl. survival of `docker restart`.
- Initialized cluster booted WITHOUT `POSTGRES_PASSWORD` in env (SL+bgw flags): healthy, env lacks the var
  (entrypoint only checks it on an empty data dir).

## 4. Zero-downtime in-place path (live command unchanged)

On the scratch cluster with the live command (no `hba_file` flag):
```
docker exec scratch-pg-5a psql -U postgres -At -c 'select 1'                      → 1 [exit 0]
docker exec scratch-pg-5a cp -p /var/lib/postgresql/data/pg_hba.conf /var/lib/postgresql/data/pg_hba.conf.pre-5a   [exit 0]
docker cp .../pg_hba.conf.socket-and-loopback scratch-pg-5a:/var/lib/postgresql/data/pg_hba.conf                 [exit 0]
docker exec scratch-pg-5a sh -c 'chown postgres:postgres /var/lib/postgresql/data/pg_hba.conf && chmod 600 /var/lib/postgresql/data/pg_hba.conf'  [exit 0]
docker exec -u postgres scratch-pg-5a pg_ctl reload -D /var/lib/postgresql/data  → server signaled [exit 0]
docker exec scratch-pg-5a psql -U postgres -At -c 'select 1'                      → refused [exit 2]
docker exec scratch-pg-5a psql -h 127.0.0.1 -U postgres -At -c 'select 1'         → refused [exit 2]
docker exec scratch-pg-5a psql -U mcp_readonly -d postgres -At -c 'select current_user' → mcp_readonly [exit 0]
docker restart scratch-pg-5a → healthy; psql -U postgres → refused [exit 2]   (file lives in the data volume)
rollback: cp -p pg_hba.conf.pre-5a pg_hba.conf; pg_ctl reload → psql -U postgres → 1 [exit 0]
```

## 5. Cleanup

`docker ps -a --filter name=scratch-pg-5a` → empty. Dangling volumes: 0 before, 0 after.
Scratch PGDATA, init dir, hba dirs and synthetic secrets deleted.

## 6. Rev 2 (after qa R1): SL + `cron.use_background_workers=on` + peer map m5a

Why: under rev 1 every host job that runs `docker exec supabase-db psql|pg_dump -U postgres|supabase_admin`
as root breaks (nightly `/opt/supabase/backup.sh`, `denue-matview-refresh.timer`, operator scripts).
Rev 2 gives them a PEER route that stores no credential: `pg_ident` map `m5a` (OS `postgres` → roles
`postgres`, `supabase_admin`) and `local all postgres,supabase_admin peer map=m5a` placed after the RO
trust line and before the socket scram line. Only `docker exec -u postgres …` (uid 105) yields that OS user.

Run: fresh scratch cluster (first boot with the live command, roles + pg_cron + pg_net + a 5000-row table
created), then booted with `-c hba_file=/etc/postgresql-5a/pg_hba.conf -c ident_file=/etc/postgresql-5a/pg_ident.conf
-c cron.use_background_workers=on`. Raw output: `run-SL-bgw-peer.log` (script `probe5a-v2.sh`).
Note: the rev-2 probe helper echoed the two synthetic `-e PGPASSWORD=` values of (h)/(h5) into the
session and the log; the log is redacted, the values belonged to a deleted throwaway cluster, the helper is fixed.

| Probe | Command (container `scratch-pg-5a`) | Result |
|---|---|---|
| (a) | boot on initialized cluster | healthy 2.1 s; `show hba_file/ident_file` = `/etc/postgresql-5a/…`; bgw `on`; `max_worker_processes` 8 |
| (b) | `docker exec C psql -U postgres -c 'select 1'` (root) | `FATAL: Peer authentication failed for user "postgres"` exit 2 |
| (b) | `docker exec C psql -U supabase_admin -d postgres` (root) | `Peer authentication failed for user "supabase_admin"` exit 2 |
| (c) | `docker exec -u postgres C psql -U postgres` | `postgres` exit 0 |
| (c) | `docker exec -u postgres C psql -U supabase_admin -d postgres` | `supabase_admin` exit 0 |
| (c2) | `docker exec -u postgres C pg_dump -U supabase_admin -d postgres --no-owner --no-acl \| gzip \| wc -c` | 109301 bytes, pipeline exit 0 |
| (c2 control) | same without `-u postgres` (= backup.sh today) | `Peer authentication failed for user "supabase_admin"` |
| (c3) | `docker exec -u 65534 C psql -U postgres` / `-U supabase_admin`; `-u root … -U supabase_admin` | all `Peer authentication failed`, exit 2 |
| (c4) | `docker exec -u postgres C psql -U t5a_ro` (role outside map) | `fe_sendauth: no password supplied` exit 2 |
| (d)/(e) | `psql -h 127.0.0.1 -U postgres`, `-U supabase_admin`, `-u postgres … -h 127.0.0.1 -U postgres`, `-h ::1 -U postgres` | all `fe_sendauth: no password supplied` exit 2 |
| (f) | `pg_isready -U supabase_admin -h localhost` | accepting; health healthy, FailingStreak 0 |
| (h) | t5a_ro with PGPASSWORD, loopback / socket | `t5a_ro` / `t5a_ro` |
| (h) | t5a_ro without password, socket / loopback | refused / refused |
| (h4) | `psql -U mcp_readonly -d postgres` (socket, no pw) | `mcp_readonly` |
| (h5) | mcp_readonly with PGPASSWORD over loopback | `mcp_readonly` |
| (bgw) | `pg_stat_activity` non-client rows | `pg_cron launcher as supabase_admin`, `pg_net 0.14.0 worker as supabase_admin`, `logical replication launcher as supabase_admin` + core; `/proc` shows `postgres: pg_net 0.14.0 worker`, `postgres: pg_cron launcher` |
| (pgnet) | `net.http_get('http://127.0.0.1:9/')` | queue before 0 → after insert 1 → after 6 s 0; `_http_response` 1 row, status_code null, error "Couldn't connect to server" |
| (g) | `cron.schedule('t5a','* * * * *',$$SELECT 1$$)` | `succeeded=1` after ~40 s |
| (i) | `docker restart`, then (a),(b),(c),(h4) | healthy 2.1 s; root `-U postgres` peer-refused; `-u postgres` → `postgres`; mcp_readonly ok |
| log | server log by shape | 7× `Connection matched pg_hba.conf line 107: "local all postgres,supabase_admin peer map=m5a"`, 3× peer failed for postgres, 4× for supabase_admin |

### Recipe R rev 2 (in place, both files, backups OUTSIDE PGDATA): `run-recipe-R-v2.log`
On a scratch container with the unchanged live command:
1. `docker cp C:/var/lib/postgresql/data/pg_hba.conf <host>/pg_hba.conf.pre-5a`, then the same for `pg_ident.conf`.
2. `docker cp` both proposed files in, `chown postgres:postgres` + `chmod 600`.
3. `docker exec -u postgres C pg_ctl reload -D /var/lib/postgresql/data` → `server signaled`.

Results after the reload:
- root `-U postgres` → `Peer authentication failed`.
- `-u postgres … -U supabase_admin` → `supabase_admin`.
- `-h 127.0.0.1 -U postgres` → refused.
- mcp_readonly (socket, no password) → ok.
- `ls PGDATA | grep -c pre-5a` → 0, so no backup copy is left in the data dir.
- After `docker restart`: healthy; root peer-refused; `-u postgres` → `postgres`.
- Rollback with `docker cp` of the host copies plus a reload: root `-U postgres` → `1`.

Before the change the in-use rule is `local all all trust`, which accepts any OS user. So the rev-2 host-job
form (`docker exec -u postgres …`) also works BEFORE the apply. That lets the host-job edits ship first.

Cleanup rev 2: `docker ps -a --filter name=scratch-pg-5a` empty; dangling volumes 0 before, 0 after;
scratch PGDATA, init, hba dir, host backups and synthetic secrets deleted.

## 7. Rev 3 (after qa R2): role inventory by mechanism + denue roles on the trust line

### 7.1 Live login roles (as mcp_readonly: `select rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls from pg_roles where rolcanlogin`)
authenticator f/f/f/f/f · denue_api f/f/f/f/f · denue_sage f/f/f/f/f · longevidad_ro f/f/f/f/f · mcp_readonly f/f/f/f/f ·
postgres t/f/f/f/f · supabase_admin t/t/t/t/t · supabase_auth_admin t/t/f/f/f · supabase_functions_admin f/t/f/f/f ·
supabase_storage_admin f/t/f/f/f · trustr_app f/f/f/f/f

### 7.2 Method
1. Ran the qa connection-identity grep for each role over `/opt/supabase /root/*.sh /root/claude /etc/systemd/system`
   (sh/ts/js/py/service/json/yml/yaml/toml). File lists are in `role-grep.txt`, paths only. File counts:
   authenticator 4 · denue_api 3 · denue_sage 10 · longevidad_ro 2 · mcp_readonly 8 · postgres 100 ·
   supabase_admin 11 · supabase_auth_admin 4 · supabase_functions_admin 0 · supabase_storage_admin 3 · trustr_app 2.
2. That pattern misses roles passed as argv variables; it did not find `psql-runner.ts`. So I also ran a
   bare-word grep per role over code (excluding node_modules, dist, tests, docs, backups) and classified
   each hit by reading the mechanism lines, with credential lines masked.
3. Checked every running service with WorkingDirectory or ExecStart under /root or /opt for runtime code
   that spawns psql or `docker exec supabase-db`, excluding scripts/ops/tests/docs.

### 7.3 Running services checked (`systemctl list-units --type=service --state=running`)

| service | WorkingDirectory | runtime psql / docker exec into supabase-db |
|---|---|---|
| agentic-crm | /root/claude/Pulso-Aura-Upfront | none (TCP :5433) |
| bariatrica-demo | /root/claude/projects/bariatrica-demo | none |
| codie-checklist | /root/claude/codie-checklist-app | none |
| denue-analyzer | /root/claude/projects/data-intelligence/denue-data-analysis | YES: `src/api/db/psql-runner.ts:110-127` argv `exec -i -e PGOPTIONS -e PGAPPNAME supabase-db psql -X -q -t -A -U <user>`, root, socket, no password. Default user `denue_api` (`API_DB_ROLE`, :72); `sql-gate.ts:737` passes `denue_sage`; `cancelBackend` reuses the same user. Callers: handlers analytics, tiles, corridor, sectors, layers-values, summary-sector, search, `analysis/cluster-by-sector.ts` (`runJson`). `src/db/loader.ts:369` `-U postgres` is reached only from the pipeline/loader scripts, not from the API. Listens on 127.0.0.1:3030. |
| eurekams-intelligence-ui (+ -longevidad) | /root/claude/eurekams-intelligence-ui/server | none; spawns intelligence-ops-mcp with `PG_HOST=localhost`, `PG_PORT=5433`, `PG_USER=mcp_readonly` (config.ts:141-144) → pg Pool, TCP |
| eurekams-mail-ui | /root/claude/eurekams-mail-ui | none |
| mission-control | /root/claude/mission-control | the shell tool runs the gate-allowed `docker exec supabase-db psql -U mcp_readonly\|longevidad_ro` (root, socket). Other hits are prompt or comment text: fast-runner.ts:1236, flailing-guard.ts:461, scope-classifier.ts, pgvector.ts:41-42. |
| salones-wa, trustr-api, uncharted-lite, very-light-cms, vlcrm, vlved, williams-radar, xpoz-pipeline | (own dirs) | none |
| opensandbox-server | — | n/a (uv tool binary) |

### 7.4 Role table (socket callers today → hba line after rev 3)

| role | super | passwordless socket caller today (OS user) | other paths | hba line after | still works? |
|---|---|---|---|---|---|
| mcp_readonly | no | mission-control gate (root); `/root/reset-mcp-readonly.sh` connects as postgres, not as this role | eurekams-ui / intelligence-ops and the `.mcp.json` supabase MCP (`127.0.0.1:5433`, no docker exec) → host TCP | `local … mcp_readonly,… trust` | yes |
| longevidad_ro | no | mission-control gate (root) | — | trust line | yes |
| denue_api | no | denue-analyzer psql-runner (root) | — | trust line | yes (proven) |
| denue_sage | no | Sage sql-gate via psql-runner (root); `ops/deploy-audit-refactor.sh:248,250` (root) | — | trust line | yes (proven) |
| postgres | yes | `refresh-matviews.sh:57` (timer), denue ops/scripts (35 files), `reset-mcp-readonly.sh`, `mn-test-insert.sh`, minisu (jarvis-kb workspace) — all root | — | `local … postgres,supabase_admin peer map=m5a` | only as `-u postgres` (APPLY Step 1) |
| supabase_admin | yes | `backup.sh:6` (root) | trustr `install-supabase-storage.sh:26,49,55` via in-container loopback; Supabase meta/studio over the bridge | peer m5a (socket) / loopback scram (SL) / `host all all all scram` (bridge) | backup: only with `-u postgres`; trustr storage script: needs its APPLY edit; bridge: yes |
| supabase_auth_admin | yes | none | gotrue over the docker bridge (compose) | `host all all all scram` (unchanged) | yes |
| authenticator | no | none | PostgREST over the bridge (the snowflake.ts hits are a Snowflake parameter of the same name) | unchanged | yes |
| supabase_storage_admin | no | none | storage container over the bridge; the trustr deploy scripts only GRANT/ALTER it | unchanged | yes |
| supabase_functions_admin | no | none (0 host references) | — | unchanged | yes |
| trustr_app | no | none | trustr-api `DATABASE_URL` → localhost:5433 TCP; the denue scripts only REVOKE from it | unchanged | yes |

Live TCP evidence (rev 1): every established connection to :5432 inside the container came from
172.20.0.x. At the time of this check there were no established host connections to :5433, so host pools
were idle. A host connection arrives through docker-proxy from the bridge gateway, never from the
container's 127.0.0.1. `/root/reset-mcp-readonly.sh` relies on the same fact ("in-container loopback is
trust, so this is the real test").

Result: no role falls silently from today's passwordless socket path to scram.
- On the trust line: mcp_readonly, longevidad_ro, denue_api, denue_sage.
- In the peer map: postgres, supabase_admin. Their callers are named in APPLY Step 1 with the `-u postgres`
  migration.

### 7.5 Scratch proof rev 3 (`run-SL-bgw-peer-rev3.log`, script `probe5a-v3.sh`)
Setup: fresh throwaway cluster, live command. Synthetic roles: postgres (SUPERUSER, synthetic password),
mcp_readonly, longevidad_ro, denue_api, denue_sage (LOGIN, no password, as on live), plus pg_cron. Booted
with the rev-3 SL file, the m5a ident file and `cron.use_background_workers=on`. Passwords were passed only
as a bare `-e PGPASSWORD`, never in argv or output. Secret scan: 0 hits.

| probe | result |
|---|---|
| (a) boot | healthy 2.2 s |
| denue_api as root over socket, analyzer form `docker exec -i -e PGOPTIONS=… -e PGAPPNAME=… C psql -X -q -t -A -U denue_api -d postgres -v ON_ERROR_STOP=1 -c 'select 1'` | `1` exit 0 |
| denue_sage as root over socket | `1` exit 0 |
| longevidad_ro / mcp_readonly as root over socket | ok / ok |
| (b) root `-U postgres` / `-U supabase_admin`, socket | `Peer authentication failed`, exit 2 |
| (W1) root `-e PGPASSWORD` (correct password) `-U postgres`, socket | `Peer authentication failed`, exit 2: the peer line does not fall through |
| (W1b) same password, `-h 127.0.0.1` | `postgres`, exit 0 |
| (c) `-u postgres` `-U postgres` / `-U supabase_admin` | `postgres` / `supabase_admin` |
| (c3) `-u 65534 -U postgres` | peer failed |
| (d)/(e) loopback without password as postgres, supabase_admin, denue_api | all refused |
| (f) health | healthy, FailingStreak 0 |
| (i) restart | healthy 2.1 s; denue_api `1`; root `-U postgres` peer failed |

Unchanged from rev 2 and not re-run: pg_cron under bgw, pg_net, pg_dump via `-u postgres`, Recipe R. The
rev-3 diff only widens the first trust line by two role names.
Cleanup: `scratch-pg-5a` removed; dangling volumes 0 before, 0 after; work dir and synthetic secrets deleted.
