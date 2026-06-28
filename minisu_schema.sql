-- =====================================================================
-- MiniSu — Schema inicial (Supabase local en VPS)
-- =====================================================================
-- Convenciones aditivas:
--   * CREATE SCHEMA IF NOT EXISTS
--   * CREATE TABLE IF NOT EXISTS (idempotente; re-ejecutable)
--   * PKs explícitas, FKs nombradas, índices nombrados
--   * timestamps con DEFAULT now()
--   * UUIDs como identificadores externos
--
-- NOTA: Esqueleto base de 8 tablas representando el núcleo multi-tenant
-- típico. El operador puede extender/ajustar columnas en migraciones
-- aditivas posteriores (ALTER TABLE ADD COLUMN IF NOT EXISTS).
-- =====================================================================

CREATE SCHEMA IF NOT EXISTS minisu;

SET search_path TO minisu, public;

-- ---------------------------------------------------------------------
-- 1. organizations — tenant raíz
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.organizations (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
    slug            TEXT NOT NULL,
    name            TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT organizations_uuid_key UNIQUE (uuid),
    CONSTRAINT organizations_slug_key UNIQUE (slug)
);

CREATE INDEX IF NOT EXISTS idx_organizations_slug
    ON minisu.organizations (slug);

-- ---------------------------------------------------------------------
-- 2. users — cuentas individuales
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.users (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    full_name       TEXT,
    password_hash   TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at   TIMESTAMPTZ,
    CONSTRAINT users_uuid_key  UNIQUE (uuid),
    CONSTRAINT users_email_key UNIQUE (email)
);

CREATE INDEX IF NOT EXISTS idx_users_email
    ON minisu.users (email);

-- ---------------------------------------------------------------------
-- 3. memberships — N:N users ↔ organizations + rol
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.memberships (
    id              BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL,
    user_id         BIGINT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner','admin','member','viewer')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT memberships_org_user_key UNIQUE (organization_id, user_id),
    CONSTRAINT fk_memberships_organization
        FOREIGN KEY (organization_id)
        REFERENCES minisu.organizations (id) ON DELETE CASCADE,
    CONSTRAINT fk_memberships_user
        FOREIGN KEY (user_id)
        REFERENCES minisu.users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memberships_org   ON minisu.memberships (organization_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user  ON minisu.memberships (user_id);

-- ---------------------------------------------------------------------
-- 4. projects — recurso primario dentro de una organización
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.projects (
    id              BIGSERIAL PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id BIGINT NOT NULL,
    slug            TEXT NOT NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT projects_uuid_key UNIQUE (uuid),
    CONSTRAINT projects_org_slug_key UNIQUE (organization_id, slug),
    CONSTRAINT fk_projects_organization
        FOREIGN KEY (organization_id)
        REFERENCES minisu.organizations (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_projects_org ON minisu.projects (organization_id);

-- ---------------------------------------------------------------------
-- 5. api_keys — credenciales programáticas por proyecto
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.api_keys (
    id              BIGSERIAL PRIMARY KEY,
    project_id      BIGINT NOT NULL,
    key_prefix      TEXT NOT NULL,
    key_hash        TEXT NOT NULL,
    name            TEXT,
    scopes          TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ,
    CONSTRAINT api_keys_prefix_key UNIQUE (key_prefix),
    CONSTRAINT fk_api_keys_project
        FOREIGN KEY (project_id)
        REFERENCES minisu.projects (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_api_keys_project ON minisu.api_keys (project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active
    ON minisu.api_keys (project_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- 6. sessions — tokens de sesión de usuario
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.sessions (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL,
    token_hash      TEXT NOT NULL,
    user_agent      TEXT,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    CONSTRAINT sessions_token_key UNIQUE (token_hash),
    CONSTRAINT fk_sessions_user
        FOREIGN KEY (user_id)
        REFERENCES minisu.users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON minisu.sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON minisu.sessions (expires_at);

-- ---------------------------------------------------------------------
-- 7. audit_log — bitácora append-only de acciones sensibles
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.audit_log (
    id              BIGSERIAL PRIMARY KEY,
    organization_id BIGINT,
    user_id         BIGINT,
    action          TEXT NOT NULL,
    target_type     TEXT,
    target_id       TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_audit_log_organization
        FOREIGN KEY (organization_id)
        REFERENCES minisu.organizations (id) ON DELETE SET NULL,
    CONSTRAINT fk_audit_log_user
        FOREIGN KEY (user_id)
        REFERENCES minisu.users (id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_org_time
    ON minisu.audit_log (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_time
    ON minisu.audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action
    ON minisu.audit_log (action);

-- ---------------------------------------------------------------------
-- 8. settings — pares clave/valor por organización
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS minisu.settings (
    id              BIGSERIAL PRIMARY KEY,
    organization_id BIGINT NOT NULL,
    key             TEXT NOT NULL,
    value           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT settings_org_key_uk UNIQUE (organization_id, key),
    CONSTRAINT fk_settings_organization
        FOREIGN KEY (organization_id)
        REFERENCES minisu.organizations (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_settings_org ON minisu.settings (organization_id);

-- =====================================================================
-- FIN — 1 schema + 8 tablas
-- =====================================================================
