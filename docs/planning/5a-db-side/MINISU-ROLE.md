# Queue 4w (ii): role `minisu` for the two Jarvis-workspace scripts (ruling a, 2026-10-19)

Operator run: `bash /root/claude/mission-control/docs/planning/5a-db-side/step3-minisu-role.sh`
(`--check-only` re-runs only the checks). Files: `minisu-role.sql`, `pg_hba.conf.socket-and-loopback` /
`.socket-only` (rev 4), `step2-apply-and-verify.sh` (trust-line regex now `...,denue_sage(,[a-z_]+)*`).

## Object / operation map (names only)
| Script (line) | psql route | Object | Operation |
| --- | --- | --- | --- |
| `minisu-batch-generator.py` (44; SQL 47-50) | `docker exec supabase-db psql -U postgres -d postgres -t -A -F '\t' -c` (root, socket) | `minisu.productos` (sku, nombre, precio_venta, categoria_id) JOIN `minisu.categorias` (id, nombre) | SELECT |
| `minisu-loop.sh` (16, Python inside `python3 -c`) | `docker exec supabase-db psql -U postgres -d postgres -t -A -c` (root, socket) | `minisu.productos` | SELECT COUNT(*) |
No INSERT/UPDATE/DELETE/TRUNCATE/DDL/COPY, no sequences, no functions, no `\copy`. Live: schema and both tables
owned by `postgres`, RLS off; productos 6 cols / 150 rows, categorias 4 cols / 6 rows. The sibling `minisu-*.py`
files contain no psql call (0 `-U` flags).

## Grants (`minisu-role.sql`)
- `CREATE ROLE minisu LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION`, then an
  `ALTER ROLE ... PASSWORD NULL` that re-asserts the attributes. No password: admitted on the socket by the trust line.
- `USAGE` on schema `minisu`; column-level `SELECT (sku, nombre, precio_venta, categoria_id)` on productos and
  `SELECT (id, nombre)` on categorias. `id`/`costo`, `slug`/`margen_pct` and the six other tables stay unreadable.
  count(*) needs SELECT on any one column. `REVOKE ALL ON ALL TABLES IN SCHEMA minisu` runs first, so the end state is exactly these grants.
- No CREATE grant and no ownership change, because the scripts only read. `REVOKE ... ON SCHEMA public` is not needed: PUBLIC holds only USAGE on
  `public` (live `=U/pg_database_owner`). CONNECT and TEMP on db `postgres` come from PUBLIC (residual, as for every role).
- Role name = schema name, so `"$user"` in search_path resolves to `minisu`. Both scripts qualify every name.
- Alternative not taken: `mcp_readonly` already has table SELECT on all 8 minisu tables. Ruling (a) asks for a dedicated narrower role.

## Who runs them
mission-control `src/`+`scripts/`: 1 hit, a `shell.test.ts` fixture (`TRUNCATE minisu.ventas`), not a caller.
`scheduled_tasks` (all text columns) 0; `tasks.input` 30 d 0 (all time 0); tasks naming either script file 30 d 0;
crontab 0; timers 0; /etc/cron* 0. `conversations` mentioning them: 5, from 2026-06-28 to 06-30. So no caller is live today.
When Jarvis does run them it uses `shell_exec`, which is `spawn("/bin/sh", ["-c", cmd])` on the HOST, not in a sandbox,
so `docker exec supabase-db psql` is reachable (the docker gate allows `exec <container> psql`).

## Registry finding
`walkKbDir` (`src/db/jarvis-reindex.ts`) and `jarvis_file_write` handle `.md` only. Drive sync mirrors `jarvis_files`.
`jarvis_files` has 206 `workspace/` rows, all `.md`, and 0 `minisu` paths. `drive_file_map` has 1 minisu path, a `.md`.
So editing the `.py`/`.sh` in place needs no reindex: Jarvis reads them from disk on the next run.
Script backups go to `/opt/supabase/volumes/db/hba-5a-script-backups/` (700). Not `hba-5a/script-backups/`, because
`hba-5a/` is bind-mounted whole into supabase-db at `/etc/postgresql-5a`, so private KB scripts placed there would be readable inside the DB container.

## Scratch proof (2026-10-19 ~21:47 UTC; `supabase/postgres:15.8.1.085`, `--network none`, live flags + 5a flags)
step3 itself was run against the scratch container (`STEP3_*` overrides, script copies in scratch).
| | Probe | Result |
| --- | --- | --- |
| (a) | `docker exec scratch psql -U minisu -At -c 'select current_user'` | `minisu` |
| (b) | edited `get_all_products()` (container name swapped) as minisu / loop.sh `python3 -c` snippet | 5 products, 3 categories / rc 0, integer |
| (c) | minisu: `count(*) minisu.ventas` / `count(costo) minisu.productos` | permission denied / permission denied |
| (d) | root `-U postgres` (also the scripts' old argv) | Peer authentication failed |
| (e) | SQL file ×2 more + full step3 rerun | exit 0; role/relacl/attacl/nspacl snapshot md5 identical; files identical |
| (f) | hba rev 3 + reload / rev 4 + reload | minisu `no password supplied`, mcp_readonly ok / minisu admitted |
| + | loopback `-h 127.0.0.1 -U minisu`; socket-only rev 4 | refused (scram); 0 rule errors, minisu admitted |
| + | drifted live hba / `--check-only` / rollback SQL | step3 exit 1, file untouched / 7 OK / exit 0, role gone, `-u postgres` peer ok |
| (g) | `docker rm -f scratch-pg-minisu` | removed; dangling volumes 0 before, 0 after; secret 0 hits in logs, shredded |

## Residuals
- step3 refuses unless the live hba sha256 = the 21:08 rev-3 install (`00f94e89…`). Any later edit means a manual diff first.
- The syntax check is `compile()` rather than `python3 -m py_compile`, so no `.pyc` lands in the KB workspace.
- The `shell.test.ts` fixture still spells `psql -U postgres ... minisu.ventas` (test-only, not changed).
- The loop.sh `python3 -c` body is shell-quoted, so a future edit to it must keep the inner quotes intact (`bash -n` checks only the outer script).
