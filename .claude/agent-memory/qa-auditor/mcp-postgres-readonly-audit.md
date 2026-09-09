---
name: mcp-postgres-readonly-audit
description: MCP server-postgres "read-only" guarantee is statement-level only; superuser connections bypass via COPY PROGRAM, pg_read_file, pg_authid. Audit pattern for any DB-MCP install.
metadata:
  type: feedback
---

# MCP @modelcontextprotocol/server-postgres "read-only" is misleading (2026-05-18)

Audit of /root/claude/.mcp.json supabase entry. Verdict: FAIL.

## The structural finding

`BEGIN READ ONLY` and `default_transaction_read_only=on` only block **data-modifying SQL statements on tables** (INSERT/UPDATE/DELETE/CREATE/etc). They do NOT block server-side operations whose write effect is filesystem or process-level. If the connection role is superuser (or has `pg_execute_server_program` / `pg_read_server_files`), ALL of these succeed inside a READ ONLY txn:

- `COPY (SELECT 1) TO PROGRAM 'sh -c ...'` — RCE as postgres OS user, returned `COPY 1` on this VPS
- `SELECT pg_read_file('/etc/passwd', 0, 200)` — returned `root:x:0:0:...`
- `SELECT * FROM pg_authid` — returns SCRAM hashes for all roles
- `SELECT pg_notify('chan', 'payload')` — side-channel into any LISTENer
- `SET ROLE other_role` — succeeds, but the txn-level RO still blocks DML; not a DML bypass

## Audit checklist for any DB-MCP install

1. **What role does the MCP connect as?** If superuser → the read-only framing is theater. Required: dedicated NOLOGIN-derived role with `pg_read_all_data` and explicitly NO `pg_execute_server_program` / NO `pg_read_server_files`.
2. **Repro the 4 bypasses above against that role.** If any returns success → fail.
3. **Where is the credential?** Grep the entire `/root` tree for the password literal. On a Claude Code box, also check `~/.claude/file-history/` (snapshots are mode 644 and survive chmod on the live file) and project-scoped `settings.local.json` files (permission rules leak credentials).
4. **Network exposure?** `ss -tlnp` + `ufw status`. Confirm the PG port is loopback-only and not behind any Caddy reverse-proxy entry.
5. **Package health.** `npm view <pkg> deprecated`. `@modelcontextprotocol/server-postgres@0.6.2` is deprecated with no successor. `@supabase/mcp-server-supabase` (0.8.1) is the actively-maintained alternative for Supabase stacks.

## Why-this-applies

**Why:** the "read-only" label on Postgres MCP servers gives operators a false floor. They assume granting a superuser conn is fine because the server "wraps in BEGIN READ ONLY." This audit confirmed live RCE inside the supabase-db container despite both the wrapper AND a URL-level `default_transaction_read_only=on`.

**How to apply:** any future MCP-DB install on this box (or any DB MCP audit elsewhere), run the 4-bypass repro AND grep for credential duplication AND check file-history mode. Don't accept "but it's read-only" as evidence — it's necessary but not sufficient. The right primitive is role-level privilege removal, not transaction-mode flags.

## Cross-refs

- [[feedback_security_audit]] — 19-item HTTP-service checklist; this extends it for DB-MCP surfaces.
- [[feedback_community_manager_email_tool_scope]] — same pattern: prompt-only guardrails ≠ safety; force the restriction at the privilege layer.
