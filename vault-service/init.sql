-- ============================================================================
-- Vault Service — Postgres Schema (Phase 1)
-- ============================================================================
-- Runs automatically on first docker-compose up via
-- /docker-entrypoint-initdb.d/init.sql
-- ============================================================================

-- Credential storage: one row per (vault_id, app_id) pair
-- vault_id = opaque user identifier mapped by PID
-- app_id   = application identifier (e.g. "app_a", "app_b")
-- fields   = JSONB blob { username, password, role, ... }
CREATE TABLE IF NOT EXISTS vault_credentials (
    vault_id    TEXT        NOT NULL,
    app_id      TEXT        NOT NULL,
    fields      JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, app_id)
);

-- Audit log: append-only record of credential operations
CREATE TABLE IF NOT EXISTS audit_log (
    id          SERIAL      PRIMARY KEY,
    vault_id    TEXT        NOT NULL,
    app_id      TEXT        NOT NULL,
    action      TEXT        NOT NULL,   -- 'read', 'write', 'update', 'delete', 'delete-vault'
    timestamp   TIMESTAMP   NOT NULL DEFAULT NOW()
);

-- Index for fast cascade-delete lookups (delete all credentials for a vault_id)
CREATE INDEX IF NOT EXISTS idx_audit_log_vault_id ON audit_log (vault_id);
CREATE INDEX IF NOT EXISTS idx_vault_credentials_vault_id ON vault_credentials (vault_id);
