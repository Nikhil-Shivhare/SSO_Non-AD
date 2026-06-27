# Vault Service Separation — Architecture Confirmation

## Overview

Separating the credential store from Primary Identity (PID) into a dedicated Vault Service, backed by HA Postgres. This document confirms component boundaries, data ownership, call flows, and migration risks before any code is written.

---

## Target Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           BROWSER                                        │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SSO Extension (unchanged)                                          │  │
│  │  background.js ─── content.js ─── utils.js                        │  │
│  └────────────┬───────────────────────────────────────────────────────┘  │
│               │                                                          │
│               │ Existing APIs (unchanged)                                │
│               │  GET  /api/session/status                                │
│               │  POST /api/plugin/bootstrap                              │
│               │  GET  /api/vault/credentials?appId=X                     │
│               │  POST /api/vault/credentials                             │
│               │  PUT  /api/vault/password                                │
│               │                                                          │
└───────────────┼──────────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ PRIMARY IDENTITY SERVICE (PID)  ─  Port 4000                             │
│                                                                           │
│  Owns: users, apps, user_apps, plugin_tokens, login_schema               │
│  Owns (SAML): saml_service_providers (acts as IdP)                       │
│  Does NOT own: vault_credentials (delegated to Vault)                    │
│                                                                           │
│  On vault API calls (Credential Replay):                                  │
│    1. Validates bearer token (plugin_tokens table)                        │
│    2. Checks user-app authorization (user_apps table)                     │
│    3. Resolves appId string → vault_id (apps table)                       │
│    4. Proxies request to Vault Service (internal network)                 │
│                                                                           │
│  On SAML calls (Federated SSO):                                           │
│    1. Validates user session cookie                                       │
│    2. Validates SP via saml_service_providers table                       │
│    3. Generates and signs SAML Assertion (Vault is bypassed entirely)     │
│                                                                           │
│  SQLite Database (PID-only tables):                                       │
│    users, apps, user_apps, plugin_tokens, saml_service_providers          │
│                                                                           │
└───────────────────────────┬───────────────────────────────────────────────┘
                            │
                            │ Internal API (new, not exposed to extension)
                            │  GET  /credentials/:vault_id/:app_id
                            │  POST /credentials/:vault_id/:app_id
                            │  PUT  /credentials/:vault_id/:app_id/password
                            │  DELETE /credentials/:vault_id/:app_id
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ VAULT SERVICE (new)  ─  Port 5000                                         │
│                                                                           │
│  Owns: credential data only                                               │
│  Stateless: no sessions, no cookies, no user context                     │
│  Horizontally scalable: multiple instances behind load balancer          │
│                                                                           │
│  Responsibilities:                                                        │
│    - Credential CRUD (identified by vault_id + app_id)                    │
│    - Field-level encryption (AES-256-GCM in production, plaintext PoC)   │
│    - Audit logging (who accessed what, when)                              │
│                                                                           │
│  Does NOT do:                                                             │
│    - Authentication (PID handles this)                                    │
│    - Authorization / policy (PID handles this)                            │
│    - Token validation (PID handles this)                                  │
│    - App metadata / login_schema (PID handles this)                       │
│                                                                           │
└───────────────────────────┬───────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ POSTGRES DATABASE (HA)                                                     │
│                                                                           │
│  Primary (read/write)  ──→  Replica 1 (read)  ──→  Replica N (read)      │
│                                                                           │
│  Table: vault_credentials                                                 │
│    vault_id    TEXT NOT NULL                                               │
│    app_id      TEXT NOT NULL                                               │
│    fields      JSONB NOT NULL       ← {username, password, role, ...}     │
│    created_at  TIMESTAMP                                                  │
│    updated_at  TIMESTAMP                                                  │
│    PRIMARY KEY (vault_id, app_id)                                         │
│                                                                           │
│  Table: audit_log                                                         │
│    id          SERIAL PRIMARY KEY                                         │
│    vault_id    TEXT NOT NULL                                               │
│    app_id      TEXT NOT NULL                                               │
│    action      TEXT NOT NULL         ← 'read', 'write', 'update', 'delete'│
│    timestamp   TIMESTAMP DEFAULT NOW()                                    │
│                                                                           │
│  Replication handled at DB layer (streaming replication, not app logic)   │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibility Table

| Responsibility                     | Current Owner | Future Owner | Notes                                                  |
| ---------------------------------- | ------------- | ------------ | ------------------------------------------------------ |
| User authentication (session)      | PID           | PID          | No change                                              |
| Admin panel (user/app CRUD)        | PID           | PID          | No change                                              |
| App registration + login_schema    | PID           | PID          | No change — login_schema stays in PID                  |
| SAML Identity Provider (IdP)       | None          | **PID**      | **New** — PID natively handles SAML 2.0 assertions     |
| User ↔ App assignment (policy)     | PID           | PID          | No change                                              |
| Plugin token issuance + validation | PID           | PID          | No change                                              |
| appId → vault_id resolution        | PID (database.py)| PID          | PID maps appId string to vault_id before calling Vault |
| Bearer token validation            | PID (app.py)  | PID          | No change — Vault never validates tokens               |
| Credential storage (CRUD)          | PID (database.py)| **Vault**    | **Moved** — physically separated                       |
| Credential encryption              | None (PoC)    | **Vault**    | **New** — Vault owns encryption layer                  |
| Audit logging (credential access)  | None          | **Vault**    | **New** — Vault logs all credential operations         |
| Cascade delete on user removal     | PID (database.py)| PID → Vault  | PID must call Vault to delete credentials              |
| Seed data (initial credentials)    | PID (database.py)| PID → Vault  | PID seeds via Vault API during bootstrap               |
| Login form detection + filling     | Extension     | Extension    | No change                                              |
| Learning mode (credential capture) | Extension     | Extension    | No change                                              |
| Password change detection          | Extension     | Extension    | No change                                              |
| **Rate limiting (brute force)**    | **PID**       | **PID**      | **Implemented** — 10 req/15min on `POST /login`, 100 on `/api/*` |

---

## The Role of SAML (Bypassing the Vault)

The introduction of **SAML 2.0 Federated SSO** creates a parallel authentication path that **does not use the Vault Service**. 

*   **Credential Replay (Extension):** Relies on the Vault Service to retrieve plaintext (or decrypted) passwords to inject into legacy DOMs.
*   **SAML Federated SSO:** Relies purely on the user's active session cookie in the PID. Once the user is logged into the PID, the PID generates a cryptographically signed XML Assertion and sends it to the Service Provider (e.g., App E).

Because SAML relies on cryptographic trust rather than password replay, the Vault Service is completely uninvolved in the SAML authentication flow. The PID stores SAML configuration in its local `saml_service_providers` table.

---

## Data Ownership Table

| Data                  | Owner     | Storage         | Accessed By                |
| --------------------- | --------- | --------------- | -------------------------- |
| users                 | PID       | PID SQLite      | PID only                   |
| apps (+ login_schema) | PID       | PID SQLite      | PID only                   |
| user_apps             | PID       | PID SQLite      | PID only                   |
| plugin_tokens         | PID       | PID SQLite      | PID only                   |
| saml_service_providers| PID       | PID SQLite      | PID only                   |
| vault_credentials     | **Vault** | **HA Postgres** | Vault only (via PID proxy) |
| audit_log             | **Vault** | **HA Postgres** | Vault only                 |

---

## Call Flow Summary

### Flow 1: Get Credentials (Auto-Login)

```
Extension                        PID                              Vault               Postgres
   │                              │                                │                     │
   ├── GET /api/vault/           │                                │                     │
   │   credentials?appId=app_a ──►│                                │                     │
   │                              ├── 1. Validate bearer token     │                     │
   │                              │    (plugin_tokens table)       │                     │
   │                              ├── 2. Check user_apps           │                     │
   │                              │    (is user allowed app_a?)    │                     │
   │                              ├── 3. Resolve appId → vault_id  │                     │
   │                              │    (apps table: app_a → "1")   │                     │
   │                              │                                │                     │
   │                              ├── GET /credentials/            │                     │
   │                              │   {vault_id}/{app_id} ─────────►                     │
   │                              │                                ├── SELECT fields     │
   │                              │                                │   FROM vault_creds ──►
   │                              │                                │                     │
   │                              │                                ◄── {fields} ─────────┤
   │                              ◄── {fields} ────────────────────┤                     │
   │                              │                                │                     │
   │                              ├── 4. Attach appId to response  │                     │
   ◄── {appId, fields} ──────────┤                                │                     │
   │                              │                                │                     │
```

### Flow 2: Save Credentials (Learning Mode)

```
Extension                        PID                              Vault               Postgres
   │                              │                                │                     │
   ├── POST /api/vault/          │                                │                     │
   │   credentials ──────────────►│                                │                     │
   │   {appId, fields}           │                                │                     │
   │                              ├── 1. Validate bearer token     │                     │
   │                              ├── 2. Check user_apps           │                     │
   │                              ├── 3. Resolve appId → vault_id  │                     │
   │                              │                                │                     │
   │                              ├── POST /credentials/           │                     │
   │                              │   {vault_id}/{app_id} ─────────►                     │
   │                              │   {fields}                     ├── UPSERT ───────────►
   │                              │                                │                     │
   │                              ◄── {success} ──────────────────┤                     │
   ◄── {success} ────────────────┤                                │                     │
```

### Flow 3: Update Password (Password Change Detection)

```
Extension                        PID                              Vault               Postgres
   │                              │                                │                     │
   ├── PUT /api/vault/            │                                │                     │
   │   password ─────────────────►│                                │                     │
   │   {appId, newPassword}       │                                │                     │
   │                              ├── 1. Validate + authorize      │                     │
   │                              ├── 2. Resolve appId → vault_id  │                     │
   │                              │                                │                     │
   │                              ├── PUT /credentials/            │                     │
   │                              │   {vault_id}/{app_id}/password ►                     │
   │                              │   {newPassword}                ├── Read existing     │
   │                              │                                ├── Merge password    │
   │                              │                                ├── UPSERT ───────────►
   │                              │                                │                     │
   │                              ◄── {success} ──────────────────┤                     │
   ◄── {success} ────────────────┤                                │                     │
```

### Flow 4: Delete User (Cascade)

```
Admin Panel                      PID                              Vault               Postgres
   │                              │                                │                     │
   ├── POST /admin/users/        │                                │                     │
   │   :id/delete ───────────────►│                                │                     │
   │                              ├── 1. Delete from users table   │                     │
   │                              ├── 2. ON DELETE CASCADE:        │                     │
   │                              │    - user_apps deleted         │                     │
   │                              │    - plugin_tokens deleted     │                     │
   │                              │                                │                     │
   │                              ├── 3. Call Vault to delete      │                     │
   │                              │    all credentials for         │                     │
   │                              │    this vault_id ──────────────►                     │
   │                              │                                ├── DELETE WHERE      │
   │                              │                                │   vault_id = X ─────►
   │                              │                                │                     │
   │                              ◄── {success} ──────────────────┤                     │
   ◄── redirect ─────────────────┤                                │                     │
```

---

## vault_id Mapping Strategy

The current system uses `user_id` (PID internal integer) + `app_id` (PID internal integer) as the vault key. In the new system:

| Concept         | Current (PID DB)          | Future (Vault DB)                    |
| --------------- | ------------------------- | ------------------------------------ |
| User identifier | `user_id` (int, PID-only) | `vault_id` (string, opaque to Vault) |
| App identifier  | `app_id` (int, PID-only)  | `app_id` (string like "app_a")       |

**vault_id** is generated by PID. The Vault never knows who the user is — only the vault_id. This preserves privacy boundaries.

> PID says: "Give me credentials for vault_id=V123, app_id=app_a"
> Vault says: "Here they are" (or "Not found")
> Vault never asks: "Who is this user? Are they allowed?"

---

## Hidden Couplings Found (Current Code)

These are places where vault operations are tangled with PID logic and must be carefully untangled during migration:

### 1. appId → app.id Resolution Inside Vault Functions

**Location**: `db.js` lines 355, 389

```javascript
// CURRENT: vault functions query the apps table internally
function getVaultCredentials(userId, appId) {
    const app = queryOne('SELECT id FROM apps WHERE appId = ?', [appId]);  // ← coupling
    ...
    queryOne('... WHERE user_id = ? AND app_id = ?', [userId, app.id]);     // ← uses int ID
}
```

**Problem**: Vault functions depend on the `apps` table (which stays in PID).

**Fix**: PID must resolve `appId` → numeric ID / vault_id before calling Vault. Vault receives only opaque identifiers.

---

### 2. User Deletion Cascades to Vault Credentials

**Location**: `db.js` line 241

```javascript
function deleteUser(id) {
    run('DELETE FROM vault_credentials WHERE user_id = ?', [id]);  // ← direct DB access
    ...
}
```

**Problem**: `deleteUser()` directly deletes vault rows via SQL. Once vault is separated, this SQL won't work.

**Fix**: PID must call Vault's `DELETE /credentials/{vault_id}` API instead of running SQL.

---

### 3. Seed Data Inserts Directly Into Vault Table

**Location**: `db.js` line 159

```javascript
db.run(
  "INSERT OR IGNORE INTO vault_credentials (user_id, app_id, app_username, app_password) VALUES (?, ?, ?, ?)",
  [testUserId, appId, "testuser", "TestPass123!"],
);
```

**Problem**: Seeding writes directly to `vault_credentials`. After separation, this table won't exist in PID's database.

**Fix**: Seed function must call Vault API to insert initial credentials.

---

### 4. updateVaultPassword Reads Before Writing

**Location**: `db.js` lines 413-419

```javascript
function updateVaultPassword(userId, appId, newPassword) {
  const existing = getVaultCredentials(userId, appId); // ← reads current fields
  const updatedFields = { ...existing.fields, password: newPassword };
  return saveVaultCredentials(userId, appId, updatedFields); // ← full overwrite
}
```

**Problem**: Password update is implemented as read-modify-write. After separation, this should be a single Vault API call.

**Fix**: Vault should expose a dedicated `PUT /credentials/:vault_id/:app_id/password` that merges internally, avoiding a round trip.

---

## Risks to Watch During Migration

| Risk                          | Severity | Description                                                                                                                    | Mitigation                                                                                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Vault unavailability**      | HIGH     | If Vault is down, all credential operations fail. Extension auto-login stops working.                                          | Health check endpoint on Vault. PID returns clear error to extension. Extension shows "service unavailable" vs cryptic failure.   |
| **Network latency**           | MEDIUM   | Extra hop (PID → Vault) adds latency to every credential fetch. Currently it's an in-process SQLite call (sub-ms).             | Vault on same network segment. Connection pooling. Consider caching credentials in PID memory with short TTL (security tradeoff). |
| **Data migration**            | HIGH     | Moving credentials from SQLite to Postgres requires re-mapping `user_id`/`app_id` integers to `vault_id`/`app_id` strings.     | Write migration script. Run in parallel (dual-write) mode first. Verify before cutover.                                           |
| **Cascade delete timing**     | MEDIUM   | User deletion in PID must now make an HTTP call to Vault. If Vault call fails, orphaned credentials remain.                    | Fire-and-forget with retry queue, OR synchronous call with transaction rollback in PID if Vault fails.                            |
| **Seed data ordering**        | LOW      | PID seed function must now wait for Vault to be running before inserting initial credentials.                                  | Add retry/health-check in seed logic. Or seed Vault independently.                                                                |
| **Password update atomicity** | MEDIUM   | Currently read-modify-write in same DB transaction. After separation, it's two HTTP calls unless Vault has dedicated endpoint. | Vault must implement `PATCH /password` internally (single DB transaction). Already planned above.                                 |
| **Backward compatibility**    | LOW      | Extension API contract is unchanged. But internal errors from Vault must be translated to match current PID error formats.     | PID proxy layer maps Vault errors to existing response shapes.                                                                    |

---

## Summary

| Question                         | Answer                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| Does extension need changes?     | **No** — all external APIs stay the same                   |
| Does PID external API change?    | **No** — PID proxies to Vault transparently                |
| Are there circular dependencies? | **No** — Extension → PID → Vault → Postgres (one-way)      |
| Is Vault truly stateless?        | **Yes** — no sessions, no tokens, no user context          |
| Can Vault scale horizontally?    | **Yes** — all state is in Postgres                         |
| Are there hidden couplings?      | **Yes, 4 found** — all documented above with fixes         |
| Is the system ready for HA?      | **Yes** — Postgres replication + stateless Vault instances |

---

##  schema 

🟦 1️⃣ PRIMARY IDENTITY DATABASE (SQLite)

Location: primary-identity/database.sqlite
Purpose: Authentication + Authorization + App Metadata
Does NOT store credentials anymore.

🔹 Table: users
| Column        | Type    | Constraints           | Description                               |
| ------------- | ------- | --------------------- | ----------------------------------------- |
| id            | INTEGER | PK AUTOINCREMENT      | Internal user ID                          |
| username      | TEXT    | UNIQUE NOT NULL       | Login username                            |
| password_hash | TEXT    | NOT NULL              | Bcrypt hash                               |
| role          | TEXT    | CHECK('admin','user') | Role in PID                               |
| vault_id      | TEXT    | UNIQUE NOT NULL       | Opaque ID used by Vault (e.g., `vault_2`) |
| created_at    | INTEGER | NOT NULL              | Unix timestamp                            |
| updated_at    | INTEGER | NOT NULL              | Unix timestamp                            |


🔎 Notes

vault_id is generated once.
Vault never sees user_id.
vault_id is privacy boundary.

🔹 Table: apps

| Column        | Type    | Constraints           | Description                               |
| ------------- | ------- | --------------------- | ----------------------------------------- |
| id            | INTEGER | PK AUTOINCREMENT      | Internal user ID                          |
| username      | TEXT    | UNIQUE NOT NULL       | Login username                            |
| password_hash | TEXT    | NOT NULL              | Bcrypt hash                               |
| role          | TEXT    | CHECK('admin','user') | Role in PID                               |
| vault_id      | TEXT    | UNIQUE NOT NULL       | Opaque ID used by Vault (e.g., `vault_2`) |
| created_at    | INTEGER | NOT NULL              | Unix timestamp                            |
| updated_at    | INTEGER | NOT NULL              | Unix timestamp                            |

Example login_schema
{
  "username": {"selector":"input[name='username']","type":"text"},
  "password": {"selector":"input[name='password']","type":"password"},
  "role": {"selector":"select[name='role']","type":"select"}
}


🔹 Table: user_apps
| Column      | Type              | Constraints   | Description          |
| ----------- | ----------------- | ------------- | -------------------- |
| user_id     | INTEGER           | FK → users.id | User                 |
| app_id      | INTEGER           | FK → apps.id  | App                  |
| created_at  | INTEGER           | NOT NULL      | Assignment timestamp |
| PRIMARY KEY | (user_id, app_id) | Composite     | Prevent duplicates   |

Purpose: Policy enforcement.


🔹 Table: plugin_tokens

| Column     | Type    | Constraints      | Description                                 |
| ---------- | ------- | ---------------- | ------------------------------------------- |
| id         | INTEGER | PK AUTOINCREMENT | Token ID                                    |
| token      | TEXT    | UNIQUE NOT NULL  | `ptk_xxx`                                   |
| user_id    | INTEGER | FK → users.id    | Token owner                                 |
| scopes     | TEXT    | NOT NULL         | JSON array (`["vault:read","vault:write"]`) |
| expires_at | INTEGER | NOT NULL         | Unix timestamp                              |
| created_at | INTEGER | NOT NULL         | Issued time                                 |

Purpose:
Extension authentication
PID validates before proxying to Vault


🔹 Table: saml_service_providers

| Column     | Type    | Constraints      | Description                                 |
| ---------- | ------- | ---------------- | ------------------------------------------- |
| id         | INTEGER | PK AUTOINCREMENT | SP ID                                       |
| name       | TEXT    | NOT NULL         | Human-readable name                         |
| entity_id  | TEXT    | UNIQUE NOT NULL  | SAML Entity ID (Issuer)                     |
| acs_url    | TEXT    | NOT NULL         | Assertion Consumer Service URL              |
| x509cert   | TEXT    |                  | Public cert for signed requests (optional)  |
| enabled    | BOOLEAN | DEFAULT 1        | Feature flag                                |

Purpose:
Stores SAML SP metadata
PID validates AuthnRequests against this table


🟩 2️⃣ VAULT DATABASE (Postgres Primary + Replica)
Location:
Primary → Port 5433
Replica → Port 5434 (read-only)

🔹 Table: vault_credentials

| Column      | Type               | Constraints   | Description                 |
| ----------- | ------------------ | ------------- | --------------------------- |
| vault_id    | TEXT               | NOT NULL      | Opaque user ID from PID     |
| app_id      | TEXT               | NOT NULL      | Public app identifier       |
| fields      | JSONB              | NOT NULL      | All login fields            |
| created_at  | TIMESTAMP          | DEFAULT NOW() | Creation                    |
| updated_at  | TIMESTAMP          | DEFAULT NOW() | Last update                 |
| PRIMARY KEY | (vault_id, app_id) | Composite     | One record per user per app |

Example fields JSONB

Simple app:
{
  "username": "nikhil",
  "password": "secret"
}

Role-based app:
{
  "username": "nikhil",
  "password": "secret",
  "role": "admin"
}


🔹 Table: audit_log
| Column    | Type      | Constraints   | Description                         |
| --------- | --------- | ------------- | ----------------------------------- |
| id        | SERIAL    | PK            | Audit ID                            |
| vault_id  | TEXT      | NOT NULL      | User vault                          |
| app_id    | TEXT      | NOT NULL      | App                                 |
| action    | TEXT      | NOT NULL      | `read`, `write`, `update`, `delete` |
| instance  | TEXT      | NULL          | vault instance name                 |
| timestamp | TIMESTAMP | DEFAULT NOW() | Event time                          |


Purpose:
Trace who accessed what
Debug multi-instance behavior
Demo compliance

🟪  Cross-System Mapping

| PID Field      | Vault Field                | Purpose          |
| -------------- | -------------------------- | ---------------- |
| users.vault_id | vault_credentials.vault_id | Identity mapping |
| apps.appId     | vault_credentials.app_id   | App mapping      |


