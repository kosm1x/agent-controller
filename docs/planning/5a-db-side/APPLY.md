# Ruling 5a option (b): operator recipe for the LIVE `supabase-db` (DRAFT rev 3, 2026-10-19; qa R1 FAIL → R2 FAIL → R3 PASS WITH WARNINGS, folded)

Run everything from the Panel terminal. Nothing here was run against the live container. Evidence: `PROOF.md`
(§0–§5 rev 1, §6 rev 2, §7 rev 3).
Files live in this directory: `/root/claude/mission-control/docs/planning/5a-db-side/` (below `<5A>`).

## Read first

1. **Mounting over `/etc/postgresql/*` does nothing here.** The compose `command:` replaces the image CMD
   (`postgres -D /etc/postgresql`), so the live server reads `/var/lib/postgresql/data/pg_hba.conf` and
   `pg_ident.conf`, which sit inside the `supabase-db-data` volume. Proven on scratch (PROOF §0).
2. **Today the socket is `trust` for every role.** It is not peer + map. Both variants keep the socket
   passwordless only for four least-privilege runtime roles, on the first `local` line:
   - `mcp_readonly` and `longevidad_ro`: the mission-control gate path;
   - `denue_api`: `denue-analyzer.service`, via `src/api/db/psql-runner.ts`;
   - `denue_sage`: Sage, via `src/api/sage/sql-gate.ts`. The role has no password by design.
   - Optional hardening: set the first `local` line's METHOD to `scram-sha-256`.
   - That needs every Jarvis call to pass `-e PGPASSWORD=$SECRET_…` first. The gate already allows it.
3. **Rev 2 adds a passwordless PEER route for OS user `postgres` only.**
   - pg_ident map `m5a`: `postgres → postgres`, `postgres → supabase_admin`.
   - pg_hba line `local all postgres,supabase_admin peer map=m5a`.
   - Only `docker exec -u postgres …` yields that OS user. Root (the default `docker exec` user) and any
     other uid are refused (PROOF §6 b, c3).
   - Host jobs use this route instead of a credential on disk.

## Variants

| | S "socket only" | SL "socket + loopback" (RECOMMENDED) |
|---|---|---|
| hba file | `<5A>/pg_hba.conf.socket-only` | `<5A>/pg_hba.conf.socket-and-loopback` |
| ident file | `<5A>/pg_ident.conf.proposed` (map m5a) | same |
| extra flags | `-c hba_file=…` `-c ident_file=…` | same + `-c cron.use_background_workers=on` (REQUIRED, or every pg_cron job fails "connection failed") |
| root `psql -U postgres` or `-U supabase_admin` (socket) | refused | refused |
| `docker exec -u postgres … psql -U postgres` or `-U supabase_admin` | allowed (peer) | allowed (peer) |
| `psql -h 127.0.0.1` / `::1` / `localhost`, `-U postgres` | **still passwordless** | refused |
| mcp_readonly / longevidad_ro / denue_api / denue_sage, socket, no password | works (status quo) | works (status quo) |
| postgres / supabase_admin WITH the right password, socket, as root or any non-mapped OS user | **refused** (the peer line matches first and does not fall through) | **refused** |
| postgres / supabase_admin WITH the right password, loopback | works (trust; no password needed) | works (scram) |
| any other role with its password, socket or loopback | works | works |

**Proof coverage.** S was proven in rev 1 without the peer line. SL+bgw+peer was proven in rev 2. The
peer line is identical in both files, and S keeps loopback trust.

**Background workers.** `cron.use_background_workers=on` runs each pg_cron job in a worker drawn from
`max_worker_processes` (8 on live; the default, unchanged). The same pool serves the pg_net worker, the
pg_cron launcher, the logical-replication launcher and parallel-query workers. Live has 0 cron jobs today
(`cron.job` n_live_tup 0). If jobs are added later, keep concurrent jobs well under the free slots, or raise
`max_worker_processes`, which needs a restart.

## Per-role summary (every live login role; inventory by mechanism in PROOF §7)

| role | super | who reaches the socket passwordless today | hba line after | keeps working? |
|---|---|---|---|---|
| mcp_readonly | no | Jarvis gate `docker exec supabase-db psql -U mcp_readonly` (root) | trust line | yes |
| longevidad_ro | no | Jarvis gate, same form | trust line | yes |
| denue_api | no | denue-analyzer.service, `psql-runner.ts:110-127` (root) | trust line | yes |
| denue_sage | no | Sage `sql-gate.ts:737` via the same runner (root); `deploy-audit-refactor.sh:248,250` | trust line | yes |
| postgres | yes | host jobs and scripts as root (Step 1) | peer m5a | only with `-u postgres` (Step 1 edits) |
| supabase_admin | yes | `backup.sh:6` (root); trustr `install-supabase-storage.sh` (loopback) | peer m5a / loopback scram | only with `-u postgres` (Step 1 edits) |
| authenticator, supabase_auth_admin, supabase_storage_admin, supabase_functions_admin | auth_admin yes | nobody: Supabase containers come over the docker bridge (scram today) | `host all all all scram` (unchanged) | yes |
| trustr_app | no | nobody: trustr-api uses `DATABASE_URL` → host :5433 TCP (scram today) | unchanged | yes |
| any role via host :5433 (Pulso, trustr, eurekams-ui / intelligence-ops `PG_HOST=localhost PG_PORT=5433`, `.mcp.json` supabase MCP) | — | none; docker-proxy delivers them from 172.20.0.x | unchanged | yes |

## Step 1: Host consumers (do this BEFORE the apply)

Every host job below runs `docker exec supabase-db … -U postgres|supabase_admin` as root over the socket.
Under S or SL each one fails with `Peer authentication failed`. The fix is `-u postgres` on the `docker exec`.

The fixed form also works TODAY, because the in-use `local all all trust` accepts any OS user. So:
1. Edit both scheduled jobs and run each once by hand.
2. Apply (Step 2).
3. Run both again by hand.

### 1a. Scheduled: must be fixed before the apply

**`/opt/supabase/backup.sh` line 6.** Root cron `0 4 * * *`, logs to `/var/log/supabase-backup.log`.

Old:
```
docker exec supabase-db pg_dump -U supabase_admin -d postgres --no-owner --no-acl | gzip > "$BACKUP_DIR/commit_ai_${TIMESTAMP}.sql.gz"
```
New:
```
docker exec -u postgres supabase-db pg_dump -U supabase_admin -d postgres --no-owner --no-acl | gzip > "$BACKUP_DIR/commit_ai_${TIMESTAMP}.sql.gz"
```
Manual run and check. It can take several minutes; watchdog notes ~7 min as the historical maximum.
```
/opt/supabase/backup.sh >> /var/log/supabase-backup.log 2>&1; echo "exit=$?"
ls -l --time-style=+%F_%T /opt/supabase/backups | tail -2
tail -1 /var/log/supabase-backup.log
```
Expect:
- `exit=0`;
- the newest `commit_ai_*.sql.gz` has today's time and a size in the same range as the previous night's
  (well above 1 MB; mission-control watchdog check 8 alerts below 1 MB);
- the last log line reads `[<date>] Backup: commit_ai_<ts>.sql.gz`.

**`/root/claude/projects/data-intelligence/denue-data-analysis/scripts/refresh-matviews.sh` line 57.** Run by
`denue-matview-refresh.timer` daily; last run 2026-10-19 04:04:53–04:06:30 UTC, Result=success. It is a
file in the denue-data-analysis git repo, so commit the edit there.

Old:
```
docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
```
New:
```
docker exec -i -u postgres "$CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<'SQL'
```
Manual run and check (about 1.5 min; it takes the MV locks, so run it outside working hours):
```
systemctl start denue-matview-refresh.service; systemctl show -p Result,ExecMainStatus denue-matview-refresh.service
systemctl list-timers denue-matview-refresh.timer --no-pager
```
Expect `Result=success`, `ExecMainStatus=0`, and the timer's NEXT run listed.

Nothing else is scheduled. Checked: root crontab (12 entries), `/etc/cron.d`, and every
`systemctl list-timers --all` unit's ExecStart. Only the two above touch supabase-db. watchdog.sh only
checks dump freshness and size. healthcheck.sh, mc-ctl validation, backup-state-bundle.sh,
`Pulso-Aura-Upfront/scripts/db-snapshot.sh`, the fantasy crons, kb-janitor, vlcms-backup, v81/v82 units:
0 matches.

### 1b. Operator-run or ad hoc: fix each one when it is next used

Rule: in shell, add `-u postgres` right after `docker exec` (or after `docker exec -i`). In a TS or Python
argv, insert `"-u", "postgres",` right after `"exec",`.
- `/root/reset-mcp-readonly.sh:17,23`: `-U postgres` → add `-u postgres`.
- `/root/claude/ops/mn-test-insert.sh:11,12`: `-U postgres` → add `-u postgres`.
- `/root/claude/projects/data-intelligence/denue-data-analysis/`, 35 non-test files spawn psql into the
  container as `-U postgres` (42 shell + 41 argv occurrences; one helper takes a `user` variable). They include:
  - `ops/denue-refresh.sh:45,54`, `ops/denue-stale-cleanup.sh:31,39`, `ops/rebuild-mortalidad-mv.sh:23,25`,
    `ops/deploy-audit-refactor.sh:26,27,113`;
  - `scripts/pipeline.ts:208` (a printed hint);
  - `scripts/load-*.ts` (censo, cofepris, eic2025, mg2025-polygons, clues, ce2024, edr, enigh, enoe, …),
    `scripts/backfill-ageb.ts`, `scripts/analyze.ts:186,198`, `scripts/cofepris-geocode.py:113,266`,
    `src/db/loader.ts:363`.

  Several share argv helpers (`scripts/_psql-tx.ts`), so fix the helper once where one exists.
- `ops/deploy-audit-refactor.sh:248,250` connect as `denue_sage` over the socket. denue_sage is on the
  trust line, so these keep working unchanged. Correction from rev 2, which wrongly said they would need a
  password.
- `/root/claude/trustr/src/__tests__/setup.ts:3` is a comment with a one-time prerequisite. Change it to
  `docker exec -u postgres supabase-db psql -U postgres -c "CREATE DATABASE trustr_test OWNER trustr_app"`.
  This is a trustr repo change.
- `/root/claude/trustr/deploy/install-supabase-storage.sh:26,49,55` use `psql -h 127.0.0.1 -U supabase_admin`.
  Under SL loopback is scram and peer does not apply to TCP. Drop `-h 127.0.0.1` and add `-u postgres`.
  Line 55 runs `sh -c 'psql …'`, so use `docker exec -i -u postgres supabase-db sh -c 'psql -U supabase_admin …'`.
- `/root/claude/mission-control/src/db/pgvector.ts:41,42` is an update-protocol comment (`-U postgres`).
  Add `-u postgres` to both lines.
- Jarvis-workspace scripts: `/root/claude/jarvis-kb/workspace/minisu-batch-generator.py:43-44` and
  `minisu-loop.sh:16` (`-U postgres`). These are exactly what 5a is meant to stop. Do NOT add
  `-u postgres` to them, because that would re-open the route for Jarvis-run code. Give them a dedicated
  least-privilege role, or let them break.

**Residual.** A script author with docker rights can write `-u postgres` just as easily as they could read a
password file. Peer closes the root default and stores no credential. It does not stop a deliberate script.

## Step 2: Apply

### Recipe C: compose (recommended; SL; about 5–20 s downtime on :5433)
```
cp -p /opt/supabase/docker-compose.yml /opt/supabase/docker-compose.yml.bak-5a-20261019
install -d -m 755 /opt/supabase/volumes/db/hba-5a
install -m 644 /root/claude/mission-control/docs/planning/5a-db-side/pg_hba.conf.socket-and-loopback /opt/supabase/volumes/db/hba-5a/pg_hba.conf
install -m 644 /root/claude/mission-control/docs/planning/5a-db-side/pg_ident.conf.proposed /opt/supabase/volumes/db/hba-5a/pg_ident.conf
```
For S, install `pg_hba.conf.socket-only` instead and skip the cron flag.

Edit `/opt/supabase/docker-compose.yml`, `db:` service. Add ONE line to `volumes:` (6 spaces before `-`):
```
    volumes:
      - supabase-db-data:/var/lib/postgresql/data
      - ./volumes/db/init:/docker-entrypoint-initdb.d
      - ./volumes/db/hba-5a:/etc/postgresql-5a:ro
```
Add THREE lines at the end of the folded `command: >` block, 6 spaces each (for S, only the first two):
```
    command: >
      postgres
      -c listen_addresses=*
      -c wal_level=logical
      -c max_wal_senders=10
      -c max_replication_slots=10
      -c shared_preload_libraries=pg_cron,pg_net
      -c cron.database_name=${POSTGRES_DB}
      -c hba_file=/etc/postgresql-5a/pg_hba.conf
      -c ident_file=/etc/postgresql-5a/pg_ident.conf
      -c cron.use_background_workers=on
```
Edit the main file, not an override. Compose merges `volumes` by target, but an override replaces
`command` outright and would have to restate all flags. The directory is mounted rather than the files,
so later host edits are not pinned to an old inode.

Check the edit (reads only the yaml):
```
grep -nE 'postgresql-5a|use_background_workers' /opt/supabase/docker-compose.yml
```
Expect 4 lines (S: 3): the volume line, `hba_file`, `ident_file`, `use_background_workers`.

Apply (this recreates `supabase-db` only):
```
cd /opt/supabase && docker compose up -d --no-deps db
```
Poll until healthy (≤ 60 s). The status reads `starting` until the first 10 s healthcheck tick:
```
for i in $(seq 1 60); do s=$(docker inspect --format '{{.State.Health.Status}}' supabase-db); [ "$s" = healthy ] && break; sleep 1; done; echo "$s after ${i}s"
```
Scratch boot to healthy took 2.1–2.8 s. Live adds a shutdown checkpoint and the 10 s tick.

### Recipe R: in place, zero downtime (fits S; SL only with a caveat)
Backups go OUTSIDE PGDATA, so they are not copied into a basebackup (PROOF §6, Recipe R rev 2):
```
install -d -m 700 /opt/supabase/volumes/db/hba-5a
docker cp supabase-db:/var/lib/postgresql/data/pg_hba.conf /opt/supabase/volumes/db/hba-5a/pg_hba.conf.pre-5a
docker cp supabase-db:/var/lib/postgresql/data/pg_ident.conf /opt/supabase/volumes/db/hba-5a/pg_ident.conf.pre-5a
docker cp /root/claude/mission-control/docs/planning/5a-db-side/pg_hba.conf.socket-and-loopback supabase-db:/var/lib/postgresql/data/pg_hba.conf
docker cp /root/claude/mission-control/docs/planning/5a-db-side/pg_ident.conf.proposed supabase-db:/var/lib/postgresql/data/pg_ident.conf
docker exec supabase-db sh -c 'cd /var/lib/postgresql/data && chown postgres:postgres pg_hba.conf pg_ident.conf && chmod 600 pg_hba.conf pg_ident.conf'
docker exec -u postgres supabase-db pg_ctl reload -D /var/lib/postgresql/data
```
For S, copy `pg_hba.conf.socket-only` instead.

Caveat for SL via R: `cron.use_background_workers` needs a restart, so pg_cron jobs fail until the flag is
added (live has 0 jobs). Add the flag at the next planned restart. R is also invisible in compose, and a
rebuild from an empty volume loses it.

## Step 3: Post-apply verification (both recipes)
```
docker exec supabase-db cat /proc/1/cmdline | tr '\0' '\n' | grep -E 'hba_file|ident_file|use_background_workers'
docker exec supabase-db psql -U postgres -c 'select 1'
docker exec supabase-db psql -U supabase_admin -d postgres -c 'select 1'
docker exec -u postgres supabase-db psql -U postgres -At -c 'select current_user'
docker exec -u 65534 supabase-db psql -U postgres -c 'select 1'
docker exec supabase-db psql -h 127.0.0.1 -U postgres -c 'select 1'
docker exec supabase-db psql -U mcp_readonly -d postgres -At -c 'select current_user'
docker exec -i supabase-db psql -X -q -t -A -U denue_api -d postgres -c 'select current_user'
docker exec -i supabase-db psql -X -q -t -A -U denue_sage -d postgres -c 'select current_user'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3030/health
read -rs K && curl -s -o /dev/null -w '%{http_code}\n' -H "X-Api-Key: $K" http://127.0.0.1:3030/entidades; unset K
journalctl -u denue-analyzer --since '-10 min' --no-pager | grep -ciE 'authentication failed|no password supplied'
docker ps --format '{{.Names}}\t{{.Status}}' | grep -E 'supabase|realtime|kong'
systemctl is-active mission-control trustr-api agentic-crm denue-analyzer
```
**Warning: do not "fix" a refused superuser call by adding a password.** After the change,
`docker exec [-e PGPASSWORD] supabase-db psql -U postgres|supabase_admin` as root, or as any OS user other
than `postgres`, is refused even WITH the correct password. The `peer map=m5a` line matches by role and
does not fall through to scram (proven, PROOF §7). The supported forms are:
- `docker exec -u postgres …` over the socket;
- under SL, `-h 127.0.0.1` plus the password.
Expected results, one per command above, in order:
1. Recipe C: 3 lines (S: 2). Recipe R: none.
2. `Peer authentication failed for user "postgres"`, exit 2.
3. Same, for `supabase_admin`.
4. `postgres`.
5. `Peer authentication failed`.
6. SL: `fe_sendauth: no password supplied`. S: `1` (S's residual).
7. `mcp_readonly`.
8. `denue_api`.
9. `denue_sage`.
10. `/health` → `200`. It does NOT touch the DB.
11. `/entidades` with the analyzer's X-Api-Key, typed at the hidden prompt → `200`. This is the cheapest
    DB-backed GET: it runs `denue_api` through `psql-runner.ts`. Without a key it answers `401`, which proves
    nothing about the DB.
12. journal count `0`.
13. Nothing `Restarting`.
14. `active` ×4.

Optional: check mcp_readonly's scram login with its own password, typed at a hidden prompt:
```
read -rs PGPASSWORD && export PGPASSWORD && docker exec -e PGPASSWORD supabase-db psql -U mcp_readonly -h 127.0.0.1 -d postgres -At -c 'select current_user'; unset PGPASSWORD
```
Then repeat both Step 1a manual runs with the same checks. The backup must give `exit=0` and a fresh
multi-MB .gz. The refresh must give `Result=success`.

## Rollback
- **Recipe C:**
  ```
  cp -p /opt/supabase/docker-compose.yml.bak-5a-20261019 /opt/supabase/docker-compose.yml && cd /opt/supabase && docker compose up -d --no-deps db
  ```
  `/opt/supabase/volumes/db/hba-5a/` may stay: nothing reads it without the flags.
- **Recipe R:**
  ```
  docker cp /opt/supabase/volumes/db/hba-5a/pg_hba.conf.pre-5a supabase-db:/var/lib/postgresql/data/pg_hba.conf
  docker cp /opt/supabase/volumes/db/hba-5a/pg_ident.conf.pre-5a supabase-db:/var/lib/postgresql/data/pg_ident.conf
  docker exec supabase-db sh -c 'cd /var/lib/postgresql/data && chown postgres:postgres pg_hba.conf pg_ident.conf && chmod 600 pg_hba.conf pg_ident.conf'
  docker exec -u postgres supabase-db pg_ctl reload -D /var/lib/postgresql/data
  ```
- **Check:** `docker exec supabase-db psql -U postgres -At -c 'select 1'` prints `1`. The Step 1 host-job
  edits can stay, because they work under trust too.

## Residual limits, stated plainly
- **Docker access is still DB-superuser access.**
  - `docker exec -u postgres` is the sanctioned route and anyone with docker rights can write it.
  - `POSTGRES_PASSWORD` (supabase_admin's password) sits in the db container env and `docker inspect`.
  - Other Supabase containers carry DB URLs; `supabase_auth_admin` is `rolsuper=t` on live, and its env was
    not inspected.
  - Anyone with docker rights can also `docker cp` a permissive hba and reload.

  This control closes the default root routes (`docker exec supabase-db psql -U postgres|supabase_admin|<any
  non-RO role>`) and, for SL, the loopback route. It does not replace the mission-control text gate,
  which refuses `-U postgres|supabase_admin` by role name.
- **Partial mitigation, not applied:** drop `POSTGRES_PASSWORD` from the `db` service `environment:`. An
  initialized cluster boots healthy without it (PROOF §3).
- **RO roles:** `mcp_readonly` / `longevidad_ro` stay passwordless on the socket (status quo).
- **Invalid files:** an invalid hba or ident file at a cold start stops the server from starting. A bad
  file on reload keeps the old rules. Both proposed files loaded cleanly on scratch.
