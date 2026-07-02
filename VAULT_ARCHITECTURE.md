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

| Column         | Type    | Constraints      | Description                                                |
| -------------- | ------- | ---------------- | ---------------------------------------------------------- |
| id             | INTEGER | PK AUTOINCREMENT | SP ID                                                      |
| name           | TEXT    | NOT NULL         | Human-readable name                                        |
| entity_id      | TEXT    | UNIQUE NOT NULL  | SAML Entity ID (Issuer)                                    |
| acs_url        | TEXT    | NOT NULL         | Assertion Consumer Service URL                            |
| name_id_format | TEXT    | DEFAULT ...      | NameID format choice (e.g. unspecified)                    |
| enabled        | INTEGER | DEFAULT 1        | Feature flag (1 = enabled, 0 = disabled)                   |
| created_at     | INTEGER | NOT NULL         | Creation Unix timestamp                                    |
| updated_at     | INTEGER | NOT NULL         | Last update Unix timestamp                                 |

Purpose:
Stores SAML SP metadata.
PID validates AuthnRequests against this table.


🔹 Table: oidc_clients

| Column        | Type    | Constraints      | Description                                       |
| ------------- | ------- | ---------------- | ------------------------------------------------- |
| id            | INTEGER | PK AUTOINCREMENT | Client ID (Primary Key)                           |
| client_id     | TEXT    | UNIQUE NOT NULL  | OIDC Client ID (e.g. `app_f`)                     |
| client_secret | TEXT    | NOT NULL         | Shared HMAC-SHA256 client secret                  |
| name          | TEXT    | NOT NULL         | Human-readable client name                        |
| redirect_uris | TEXT    | NOT NULL         | JSON array of allowed redirection URIs            |
| enabled       | INTEGER | DEFAULT 1        | Feature flag (1 = enabled, 0 = disabled)          |
| created_at    | INTEGER | NOT NULL         | Creation Unix timestamp                           |
| updated_at    | INTEGER | NOT NULL         | Last update Unix timestamp                        |

Purpose:
Stores OIDC Relying Party (client) metadata.
PID validates authorize/token requests against this table.


🔹 Table: oidc_authorization_codes

| Column       | Type    | Constraints      | Description                                       |
| ------------ | ------- | ---------------- | ------------------------------------------------- |
| id           | INTEGER | PK AUTOINCREMENT | Code ID                                           |
| code         | TEXT    | UNIQUE NOT NULL  | Opaque single-use authorization code string       |
| client_id    | TEXT    | NOT NULL         | Target Client ID                                  |
| user_id      | INTEGER | FK → users.id    | Authenticated User ID                             |
| redirect_uri | TEXT    | NOT NULL         | Redirect URI used in `/authorize`                 |
| scope        | TEXT    | NOT NULL         | Scope string requested by client                  |
| nonce        | TEXT    |                  | Cryptographic nonce to embed in ID Token (or NULL)|
| expires_at   | INTEGER | NOT NULL         | Expiry Unix timestamp (typically 5 mins TTL)      |
| used         | INTEGER | DEFAULT 0        | Single-use flag (1 = consumed, 0 = active)        |
| created_at   | INTEGER | NOT NULL         | Creation Unix timestamp                           |

Purpose:
Temporarily stores issued OIDC authorization codes. Enforces single-use consumption.


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









## The Role of SAML (Bypassing the Vault)

The introduction of **SAML 2.0 Federated SSO** creates a parallel authentication path that **does not use the Vault Service**. 

*   **Credential Replay (Extension):** Relies on the Vault Service to retrieve plaintext (or decrypted) passwords to inject into legacy DOMs.
*   **SAML Federated SSO:** Relies purely on the user's active session cookie in the PID. Once the user is logged into the PID, the PID generates a cryptographically signed XML Assertion and sends it to the Service Provider (e.g., App E).

Because SAML relies on cryptographic trust rather than password replay, the Vault Service is completely uninvolved in the SAML authentication flow. The PID stores SAML configuration in its local `saml_service_providers` table.

---

## SAML 2.0 Federated SSO Architecture

While Credential Replay injects credentials into the DOM of unmodified legacy apps, **SAML 2.0 Federated SSO** establishes direct cryptographic trust between the Primary Identity Service (PID) acting as the **Identity Provider (IdP)** and standard-compliant applications acting as **Service Providers (SPs)**. 

No passwords or credentials are stored or replayed to the SP; instead, the browser carries a cryptographically signed XML Assertion confirming the user's identity.

### SAML SSO Target Architecture

```
                                BROWSER
                                   │
       1. Access App E             │ 3. Redirect to PID /saml/sso with AuthnRequest
     ┌─────────────────────────────┼─────────────────────────────┐
     │                             │                             │
     ▼                             ▼                             ▼
┌────────────────────────┐  2. Gen Request ID  ┌────────────────────────┐
│   SAML SERVICE         ├────────────────────►│    PRIMARY IDENTITY    │
│   PROVIDER (SP)        │                     │     SERVICE (PID)      │
│  (App E - Port 3005)   │  4. Validate ACS    │     (IdP - Port 4000)  │
│                        │     & Issuer        │                        │
│  - Generates Request ID│◄────────────────────┤ - Decodes & Parses XML │
│  - Caches Request ID   │                     │ - Validates SP EntityID│
│  - Validates XML Signature                   │ - Verifies user session│
│  - Handles ACS URL     │  7. Auto-POST Form  │ - Signs Assertion      │
│                        │◄────────────────────┤ - Renders POST Form    │
└──────────┬─────────────┘                     └───────────┬────────────┘
           │                                               │
           │                                               │ 5. Lookup SP ACS
           │                                               ▼
           │                                           ┌────────┐
           │                                           │ SQLite │
           │                                           │   DB   │
           │                                           └────────┘
           │ 6. Create Local Session
           ▼
    [App E Dashboard]
```

### Call Flow: SP-Initiated SAML SSO

This sequence details how a user logs into SAML App E using their active PID session:

```
Browser                     App E (SP)                      PID (IdP)                      SQLite DB
   │                            │                               │                              │
   │─── 1. Access App E ───────►│                               │                              │
   │                            ├─── 2. Generate AuthnRequest   │                              │
   │                            │    & cache Request ID         │                              │
   │                            │                               │                              │
   │◄── 3. Redirect to IdP ─────┤                               │                              │
   │    with SAMLRequest        │                               │                              │
   │    (HTTP-Redirect)         │                               │                              │
   │                            │                               │                              │
   │─── 4. GET /saml/sso ───────┼──────────────────────────────►│                              │
   │    with SAMLRequest        │                               ├── 5. Decode & Parse          │
   │                            │                               │      AuthnRequest            │
   │                            │                               ├── 6. SELECT sp info ────────►│
   │                            │                               │◄──── Return entity_id/acs ───┤
   │                            │                               │                              │
   │                            │                               ├── 7. Validate ACS & Issuer   │
   │                            │                               │                              │
   │                            │                               ├── 8. Check PID_SESSION       │
   │                            │                               │                              │
   │                            │                               │    [If Not Logged In]        │
   │◄── 9a. Redirect to /login ─┼───────────────────────────────┤                              │
   │                            │                               │                              │
   │─── 9b. POST /login ────────┼──────────────────────────────►│                              │
   │    (with credentials)      │                               ├── 9c. Authenticate User      │
   │                            │                               ├── 9d. Restore pending SAML   │
   │◄── 9e. Redirect to resume ─┼───────────────────────────────┤                              │
   │                            │                               │                              │
   │─── 10. GET /saml/resume ───┼──────────────────────────────►│                              │
   │                            │                               ├── 11. Build SAMLResponse XML │
   │                            │                               │       using lxml             │
   │                            │                               ├── 12. Sign Assertion with    │
   │                            │                               │       dev-idp.key (signxml)  │
   │                            │                               ├── 13. Clear pending SAML     │
   │                            │                               │                              │
   │◄── 14. HTML Auto-POST form ┼───────────────────────────────┤                              │
   │                            │                               │                              │
   │─── 15. POST /saml/acs ────►│                               │                              │
   │    with SAMLResponse       ├── 16. Validate response:      │                              │
   │                            │       - Signature check       │                              │
   │                            │       - Issuer & Audience     │                              │
   │                            │       - InResponseTo cache    │                              │
   │                            │       - Clock skew/expiry     │                              │
   │                            │                               │                              │
   │                            ├── 17. Create App E Session    │                              │
   │◄── 18. Redirect /dashboard ┤                               │                              │
```

### Technical Detail & Implementation Components

#### 1. AuthnRequest Decoding and Parsing
*   **Protocol Binding**: HTTP-Redirect (GET).
*   **Decompression Pipeline**: The framework query-parser automatically URL-decodes the `SAMLRequest` string. PID then base64-decodes and decompresses the raw DEFLATE bytes (using negative window bits to bypass the zlib header):
    ```python
    zlib.decompress(base64.b64decode(raw_saml_request), -zlib.MAX_WBITS)
    ```
*   **Parsing**: Built using `lxml.etree` to extract the `ID` attribute, the `<saml:Issuer>` text, and the `<samlp:AuthnRequest>` attribute `AssertionConsumerServiceURL`.

#### 2. Service Provider Registration & ACS Injection Protection
To prevent malicious redirection of SAML responses (ACS URL Injection), the PID IdP strictly validates requests using a registered list of Service Providers stored in its SQLite database:
*   The SP's `Issuer` (Entity ID) is queried against `saml_service_providers`. If not found or disabled, PID rejects the request with a `403 Forbidden`.
*   The ACS URL is loaded directly from the database record (`acs_url`) rather than trusting the ACS URL specified in the incoming XML payload.

#### 3. State Preservation & Cookie Size Safety
*   When an unauthenticated user arrives with a valid SAML request, PID redirects them to `/login`.
*   To keep the user's flow context, the incoming SAML metadata (`request_id`, `issuer`, `acs_url`, `relay_state`) is saved to the session.
*   **Cookie size limitation**: Raw XML is never placed in the session because Starlette signed-cookie sessions have a 4KB limit. Doing so causes silent session write failures.
*   Upon successful login, a post-login handler checks for `pending_saml_request`, restores it to the newly initialized session, and routes the browser to `/saml/resume` to complete the assertion generation.

#### 4. SAML Assertion Construction & Standalone XML Signing
PID generates and signs only the `<saml:Assertion>` element inside an unsigned `<samlp:Response>` envelope. This matches standard enterprise-level assertions:
*   **Libraries**: Built using `lxml` for structured XML nodes and signed using `signxml.XMLSigner`.
*   **Enveloped Assertion-Only Signing**:
    1. The assertion element is created and temporarily detached from the main response.
    2. `XMLSigner` signs the assertion standalone with the IdP private key (`dev-idp.key`), embedding a `<ds:Signature>` element as the first child of the assertion.
    3. The signer is explicitly configured with `id_attribute_name="ID"` to bind the signature reference to the Assertion's ID attribute.
    4. The signed assertion element is re-attached as a child of the response.
*   **Validity Window**: The assertion is set with a short Time-To-Live (`assertion_ttl_seconds = 300` / 5 minutes) and a clock skew tolerance (`clock_skew_seconds = 120` / 2 minutes) under `<saml:Conditions>`.

#### 5. HTTP-POST Auto-Submission Form
The base64-encoded `SAMLResponse` is sent to the SP ACS URL using the HTTP-POST binding. The PID returns a self-submitting HTML page that triggers standard JavaScript execution:
```html
<body onload="document.forms[0].submit()">
  <form id="saml-form" method="POST" action="{acs_url}">
    <input type="hidden" name="SAMLResponse" value="{saml_response_b64}">
    <input type="hidden" name="RelayState" value="{relay_state}">
  </form>
</body>
```

#### 6. Service Provider ACS Verification
When the browser submits the POST request to App E's `/saml/acs` endpoint:
*   **CSRF Exclusion**: The endpoint is excluded from CSRF middleware checks. Cryptographic checks alone are sufficient to verify cross-origin POST authenticity.
*   **Validation Checks**: App E utilizes `@node-saml/node-saml` to validate the assertion:
    *   **Signature**: Validates signature using the IdP's public cert (`dev-idp.crt`).
    *   **InResponseTo**: Compares the response `InResponseTo` against the original `AuthnRequest` ID generated by App E. The library manages this automatically using its internal request cache.
    *   **Audience/Recipient**: Verifies that Audience matches App E Entity ID and Recipient matches App E ACS URL.
    *   **Expiry**: Validates timestamps against clock skew.
*   Upon validation, App E starts a local express session and redirects the user to `/dashboard`.

---

## OpenID Connect (OIDC) Federated SSO Architecture

While SAML 2.0 uses XML-based assertions and HTTP-POST/HTTP-Redirect bindings, **OIDC Federated SSO** is a lightweight, JSON/JWT-centric federated authentication protocol built on top of OAuth 2.0. In this configuration, the **Primary Identity Service (PID)** acts as the **OpenID Provider (OP)**, and **App F** (running on port 3006) acts as the **Relying Party (RP)** or OIDC Client.

Like SAML, the OIDC flow bypasses the Vault Service completely, relying on central PID sessions and cryptographic tokens to establish trust.

### OIDC SSO Target Architecture

```
                                BROWSER
                                   │
       1. Access App F             │ 3. Redirect to PID /authorize with params
     ┌─────────────────────────────┼─────────────────────────────┐
     │                             │                             │
     ▼                             ▼                             ▼
┌────────────────────────┐  2. Gen state/nonce ┌────────────────────────┐
│   OIDC CLIENT / RP     ├────────────────────►│  OPENID PROVIDER (OP)  │
│  (App F - Port 3006)   │                     │     (PID - Port 4000)  │
│                        │  4. Validate Client │                        │
│  - Generates State &   │     & Redirect URI  │ - Authenticates User   │
│    Nonce               │◄────────────────────┤ - Generates Auth Code  │
│  - Persists State &    │                     │ - Returns Auth Code    │
│    Nonce in session    │  5. callback?code   │                        │
│                        │◄────────────────────┤                        │
│  - Server-side POST to │                     └───────────┬────────────┘
│    /token with secret  │                                 │
│  - Validates ID Token  ├──────────────────────────────┐  │ 6. Lookup Client /
│    (HS256 signature,   │   6. POST /token             │  │    Verify Code
│     claims, nonce)     │◄─────────────────────────────┘  ▼
└────────────────────────┘                             ┌────────┐
                                                       │ SQLite │
                                                       │   DB   │
                                                       └────────┘
```

### Call Flow: SP-Initiated OIDC SSO (Authorization Code Flow)

This sequence details how a user logs into App F using their active PID session via the Authorization Code Flow:

```
Browser                     App F (RP)                      PID (OP)                       SQLite DB
   │                            │                               │                              │
   │─── 1. Access App F ───────►│                               │                              │
   │                            ├─── 2. Generate state, nonce   │                              │
   │                            │    & save to session          │                              │
   │                            │                               │                              │
   │◄── 3. Redirect to OP ──────┤                               │                              │
   │    with state/nonce        │                               │                              │
   │    (HTTP-Redirect)         │                               │                              │
   │                            │                               │                              │
   │─── 4. GET /authorize ──────┼──────────────────────────────►│                              │
   │    with query parameters   │                               ├── 5. Validate client_id &    │
   │                            │                               │      redirect_uri            │
   │                            │                               ├── 6. SELECT Client Info ────►│
   │                            │                               │◄──── Return client record ───┤
   │                            │                               │                              │
   │                            │                               ├── 7. Check PID_SESSION       │
   │                            │                               │                              │
   │                            │                               │    [If Not Logged In]        │
   │◄── 8a. Redirect to /login ─┼───────────────────────────────┤                              │
   │                            │                               │                              │
   │─── 8b. POST /login ────────┼──────────────────────────────►│                              │
   │    (with credentials)      │                               ├── 8c. Authenticate User      │
   │                            │                               ├── 8d. Restore pending OIDC   │
   │◄── 8e. Redirect to resume ─┼───────────────────────────────┤                              │
   │                            │                               │                              │
   │─── 9. GET /oidc/resume ────┼──────────────────────────────►│                              │
   │                            │                               ├── 10. Generate Auth Code     │
   │                            │                               ├── 11. Save code & nonce ────►│
   │                            │                               ├── 12. Clear pending OIDC     │
   │                            │                               │                              │
   │◄── 13. Redirect to Callback┼───────────────────────────────┤                              │
   │    with ?code=CODE&state   │                               │                              │
   │                            │                               │                              │
   │─── 14. GET /callback ─────►│                               │                              │
   │    with code & state       │                               │                              │
   │                            ├── 15. Check state matches     │                              │
   │                            │       session value           │                              │
   │                            │                               │                              │
   │                            ├── 16. POST /token (back-channel) ───────────────────────────►│
   │                            │       (code, client_id, client_secret)                       │
   │                            │                               ├── 17. Validate credentials & │
   │                            │                               │       verify & consume code  │
   │                            │                               ├── 18. Build ID Token & Access│
   │                            │◄────── 19. Return Tokens ─────┤                              │
   │                            │        (Access + ID Token)    │                              │
   │                            │                               │                              │
   │                            ├── 20. Verify ID Token:        │                              │
   │                            │       - HS256 signature       │                              │
   │                            │       - issuer & audience     │                              │
   │                            │       - nonce matches session │                              │
   │                            │       - exp/iat time check    │                              │
   │                            │                               │                              │
   │                            ├── 21. Create App F Session    │                              │
   │◄── 22. Redirect /dashboard ┤                               │                              │
```

### Technical Detail & Implementation Components

#### 1. Discovery and JWKS Endpoints
*   **Discovery Document**: PID implements `GET /.well-known/openid-configuration` (RFC 8414). This JSON metadata allows clients like App F to auto-discover token, authorization, and userinfo endpoints, supported scopes, and signing algorithms.
*   **JWKS Endpoint**: Located at `GET /.well-known/jwks.json`. For the MVP, PID signs JWTs using symmetric HS256 (HMAC-SHA256).
    *   **JWKS Security**: An empty `{"keys": []}` array is returned. Publishing symmetric secrets publicly is insecure. The client verifies signatures using the registered `client_secret` directly as the HMAC verification key.

#### 2. Client Authentication & Token Signing (HS256)
*   **Signing Key Strategy**: Following OIDC Core §10.1, when signing JWTs via symmetric `HS256`, the signing key is the UTF-8 bytes of the `client_secret` registered for that specific client.
*   **Token Endpoint Authentication**: App F authenticates to PID's `/token` endpoint using the `client_secret_post` method, sending credentials (`client_id` and `client_secret`) directly in the HTTP POST body.
*   **ID Token JWT Claims**: Signed using `pyjwt` with the client's secret, containing:
    *   `iss`: Identity Provider issuer URL (`http://localhost:4000`)
    *   `sub`: Stable username identifier
    *   `aud`: Client ID (`app_f`)
    *   `nonce`: Echoed cryptographic nonce matching the request parameter
    *   `name` / `preferred_username` / `email` (synthetic for scope profile/email)
*   **Access Token JWT Claims**: Issued as a separate short-lived JWT signed using the provider's internal secret (`_OIDC_SECRET`) for use at `/userinfo`.

#### 3. State & Nonce Handling on Relying Party (App F)
*   **Generation**: App F uses `openid-client`'s `generators.state()` and `generators.nonce()` to generate random cryptographic strings before redirecting the browser.
*   **Session Persistence**: Because the `openid-client` library does not persist state across redirects, App F must manually save `oidc_state` and `oidc_nonce` in the express session.
*   **Local Session Cookie Constraints**: On HTTP localhost, the Express session cookie's `secure` flag MUST be set to `false`. If set to `true`, the browser will discard the session cookie, resulting in lost state/nonce data and a "checks.state argument is missing" error.

#### 4. Authorization Code Lifecycle & Security
*   **Single-Use Enforcement**: Issued codes are stored in the SQLite `oidc_authorization_codes` table with a short TTL (5 minutes). When `/token` is called, the code is queried, checked for expiration, and immediately marked as `used = 1`. Any subsequent attempt to use the same code is rejected.
*   **Redirect URI Validation**: To prevent Open Redirector vulnerabilities, the `redirect_uri` sent to `/authorize` must exactly match the list of allowed URIs registered in the `redirect_uris` JSON field of `oidc_clients`.

#### 5. UserInfo Endpoint Authentication
*   **Bearer Auth**: The `GET /userinfo` endpoint requires an `Authorization: Bearer <access_token>` header.
*   **Inline Verification**: PID decodes the Bearer token (issued as a JWT) using its internal secret `_OIDC_SECRET`. This validates scope and identity without querying the database, reducing database load.

---
