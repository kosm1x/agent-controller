-- minisu-role.sql — queue item 4w (ii), ruling (a) 2026-10-19.
-- Least-privilege login role for the two Jarvis-workspace scripts that read the
-- minisu catalog over the container socket:
--   /root/claude/jarvis-kb/workspace/minisu-batch-generator.py  line 44 (psql -U ... -d postgres)
--   /root/claude/jarvis-kb/workspace/minisu-loop.sh             line 16 (psql -U ... -d postgres)
-- Both are READ-ONLY: two SELECTs, no writes, no DDL, no COPY, no sequences, no functions.
--
-- Applied by step3-minisu-role.sh as:
--   docker exec -i -u postgres supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f - < minisu-role.sql
-- Idempotent: a second run exits 0 and leaves pg_roles / relacl / attacl / nspacl unchanged.
-- Fails (and rolls back) if schema minisu or one of the named columns is missing.
--
-- No password: the role is admitted on the Unix socket by the first pg_hba line
-- (`local all mcp_readonly,...,minisu trust`, rev 4), like denue_api / denue_sage.
-- Over TCP (loopback or bridge) it has no password, so scram refuses it.
--
-- Not needed: REVOKE ALL ON SCHEMA public FROM minisu. In PG15 PUBLIC holds only
-- USAGE on schema public (live nspacl: `=U/pg_database_owner`), no CREATE, and a
-- grant held by PUBLIC cannot be revoked per role anyway. Likewise CONNECT and
-- TEMP on database postgres come from PUBLIC (`=Tc/supabase_admin`) and are left as is.
-- The role name equals the schema name: with the default search_path ("$user", public)
-- unqualified names resolve to schema minisu first. Both scripts schema-qualify every name.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'minisu') THEN
    CREATE ROLE minisu LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION;
  END IF;
END
$$;
-- Re-assert the attributes if the role pre-existed with different ones; PASSWORD NULL = no password stored.
ALTER ROLE minisu LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD NULL;

-- Both scripts: every object they touch lives in schema minisu.
GRANT USAGE ON SCHEMA minisu TO minisu;

-- Converge to exactly the grants below (a table-level REVOKE also drops column grants).
REVOKE ALL ON ALL TABLES IN SCHEMA minisu FROM minisu;

-- minisu-batch-generator.py lines 47-50: SELECT p.sku, p.nombre, p.precio_venta ... JOIN ON p.categoria_id ... ORDER BY p.sku
-- minisu-loop.sh line 16: SELECT COUNT(*) FROM minisu.productos (any one granted column suffices for count(*)).
-- Column-level: productos.id and productos.costo stay unreadable.
GRANT SELECT (sku, nombre, precio_venta, categoria_id) ON minisu.productos TO minisu;

-- minisu-batch-generator.py lines 47-49: c.nombre, JOIN ... ON p.categoria_id = c.id
-- Column-level: categorias.slug and categorias.margen_pct stay unreadable.
GRANT SELECT (id, nombre) ON minisu.categorias TO minisu;

-- Nothing on minisu.ventas, venta_items, inventario_semanal, mermas, tiendas, zonas or any sequence.

COMMIT;
