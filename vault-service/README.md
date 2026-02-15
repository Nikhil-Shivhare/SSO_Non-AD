# Vault Service

Stateless credential storage service for the SSO architecture.

> **Note:** This service is internal-only. It is called exclusively by Primary Identity Service (PID) — never directly by the browser extension.

## Quick Start

```bash
cd vault-service
docker-compose up -d
```

Service runs at: **http://localhost:5000**

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Vault Service                               │
├─────────────────────────────────────────────────────────────────┤
│  Port: 5000                                                     │
│                                                                  │
│  Owns: vault_credentials (PostgreSQL)                          │
│  Stateless: no sessions, no cookies, no user context            │
│                                                                  │
│  Responsibilities:                                              │
│    - Credential CRUD (identified by vault_id + app_id)          │
│    - Field-level encryption (AES-256-GCM in production)         │
│    - Audit logging (who accessed what, when)                   │
│                                                                  │
│  Does NOT do:                                                   │
│    - Authentication (PID handles this)                          │
│    - Authorization / policy (PID handles this)                  │
│    - Token validation (PID handles this)                      │
│    - App metadata / login_schema (PID handles this)            │
└─────────────────────────────────────────────────────────────────┘
```

## API Reference

### Internal Endpoints

> **Note:** These endpoints are for PID → Vault communication only.

| Method | Endpoint                          | Purpose                         |
| ------ | --------------------------------- | ------------------------------- |
| GET    | `/health`                         | Health check                    |
| POST   | `/internal/vault/read`            | Read credentials                |
| POST   | `/internal/vault/write`           | Upsert credentials              |
| POST   | `/internal/vault/update-password` | Update password only (merge)    |
| POST   | `/internal/vault/delete`          | Delete single credential        |
| POST   | `/internal/vault/delete-vault`    | Delete all credentials for user |

### Request/Response Examples

#### Read Credentials

```bash
curl -X POST http://localhost:5000/internal/vault/read \
  -H "Content-Type: application/json" \
  -d '{"vaultId": "vault_1", "appId": "app_a"}'
```

**Response:**

```json
{
  "fields": {
    "username": "nikhil",
    "password": "secret",
    "role": "admin"
  }
}
```

#### Write Credentials

```bash
curl -X POST http://localhost:5000/internal/vault/write \
  -H "Content-Type: application/json" \
  -d '{"vaultId": "vault_1", "appId": "app_a", "fields": {"username": "nikhil", "password": "secret"}}'
```

**Response:**

```json
{
  "success": true
}
```

#### Update Password Only

```bash
curl -X POST http://localhost:5000/internal/vault/update-password \
  -H "Content-Type: application/json" \
  -d '{"vaultId": "vault_1", "appId": "app_a", "newPassword": "newsecret"}'
```

**Response:**

```json
{
  "success": true
}
```

#### Delete Credential

```bash
curl -X POST http://localhost:5000/internal/vault/delete \
  -H "Content-Type: application/json" \
  -d '{"vaultId": "vault_1", "appId": "app_a"}'
```

**Response:**

```json
{
  "success": true
}
```

#### Delete All Credentials for User

```bash
curl -X POST http://localhost:5000/internal/vault/delete-vault \
  -H "Content-Type: application/json" \
  -d '{"vaultId": "vault_1"}'
```

**Response:**

```json
{
  "success": true,
  "deletedCount": 3
}
```

## Database

PostgreSQL database. Schema is auto-created on first run.

### Tables

| Table               | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `vault_credentials` | Per-user app credentials (vault_id, app_id, fields JSONB) |
| `audit_log`         | Append-only record of credential operations               |

### vault_credentials Schema

| Column      | Type               | Constraints         | Description                                  |
| ----------- | ------------------ | ------------------- | -------------------------------------------- |
| vault_id    | TEXT               | NOT NULL            | Opaque user ID from PID                      |
| app_id      | TEXT               | NOT NULL            | Application identifier                       |
| fields      | JSONB              | NOT NULL DEFAULT {} | Login fields {username, password, role, ...} |
| created_at  | TIMESTAMP          | NOT NULL            | Creation timestamp                           |
| updated_at  | TIMESTAMP          | NOT NULL            | Last update timestamp                        |
| PRIMARY KEY | (vault_id, app_id) |                     | One record per user per app                  |

### audit_log Schema

| Column    | Type      | Constraints | Description                                         |
| --------- | --------- | ----------- | --------------------------------------------------- |
| id        | SERIAL    | PK          | Audit ID                                            |
| vault_id  | TEXT      | NOT NULL    | User vault                                          |
| app_id    | TEXT      | NOT NULL    | App                                                 |
| action    | TEXT      | NOT NULL    | `read`, `write`, `update`, `delete`, `delete-vault` |
| timestamp | TIMESTAMP | NOT NULL    | Event time                                          |

## Security Notes (PoC Only)

- Credentials stored as JSONB in PostgreSQL
- In production: encrypt fields with AES-256-GCM before storage
- No authentication on internal endpoints (assumes trusted network)
- In production: use mTLS or VPN for PID ↔ Vault communication

## View Audit Logs (SQL)

```bash
psql -h localhost -p 5433 -U vault_user -d vault_db -c "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"
```

```bash
psql -h localhost -p 5433 -U vault_user -d vault_db -c "SELECT * FROM vault_credentials;"
```
