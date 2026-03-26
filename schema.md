# Database Schema Documentation

This document provides a comprehensive schema of all database entities across the system.

---

## 1. Primary Identity (PID) — SQLite

**Database:** `primary-identity/database.sqlite`

### 1.1 users

| Column        | Type    | Constraints                               | Description                           |
| ------------- | ------- | ----------------------------------------- | ------------------------------------- |
| id            | INTEGER | PK AUTOINCREMENT                          | Internal user ID                      |
| username      | TEXT    | UNIQUE NOT NULL                           | Login username                        |
| password_hash | TEXT    | NOT NULL                                  | Bcrypt hash of password               |
| role          | TEXT    | NOT NULL CHECK(role IN ('admin', 'user')) | User role                             |
| vault_id      | TEXT    |                                           | Opaque ID for Vault (e.g., `vault_1`) |

### 1.2 apps

| Column       | Type    | Constraints      | Description                                    |
| ------------ | ------- | ---------------- | ---------------------------------------------- |
| id           | INTEGER | PK AUTOINCREMENT | Internal app ID                                |
| appId        | TEXT    | UNIQUE NOT NULL  | Public app identifier (e.g., `app_a`)          |
| origin       | TEXT    | NOT NULL         | App origin URL (e.g., `http://localhost:3001`) |
| login_schema | TEXT    | NULL             | JSON string with form field selectors          |

**Example login_schema:**

```json
{
  "username": { "selector": "input[name='username']", "type": "text" },
  "password": { "selector": "input[name='password']", "type": "password" },
  "role": { "selector": "select[name='role']", "type": "select" }
}
```

### 1.3 user_apps

| Column      | Type              | Constraints                      | Description   |
| ----------- | ----------------- | -------------------------------- | ------------- |
| user_id     | INTEGER           | FK → users(id) ON DELETE CASCADE | User ID       |
| app_id      | INTEGER           | FK → apps(id) ON DELETE CASCADE  | App ID        |
| PRIMARY KEY | (user_id, app_id) |                                  | Composite key |

### 1.4 plugin_tokens

| Column     | Type    | Constraints                      | Description                                       |
| ---------- | ------- | -------------------------------- | ------------------------------------------------- |
| id         | INTEGER | PK AUTOINCREMENT                 | Token ID                                          |
| token      | TEXT    | UNIQUE NOT NULL                  | Token string (e.g., `ptk_xxx`)                    |
| user_id    | INTEGER | FK → users(id) ON DELETE CASCADE | Owner user ID                                     |
| scopes     | TEXT    | NOT NULL                         | JSON array (e.g., `["vault:read","vault:write"]`) |
| expires_at | INTEGER | NOT NULL                         | Unix timestamp of expiration                      |

---

## 2. Vault Service — PostgreSQL

**Database:** `vault_db` (port 5433)

### 2.1 vault_credentials

| Column      | Type               | Constraints            | Description                                  |
| ----------- | ------------------ | ---------------------- | -------------------------------------------- |
| vault_id    | TEXT               | NOT NULL               | Opaque user ID from PID (e.g., `vault_1`)    |
| app_id      | TEXT               | NOT NULL               | App identifier (e.g., `app_a`)               |
| fields      | JSONB              | NOT NULL DEFAULT '{}'  | Login fields {username, password, role, ...} |
| created_at  | TIMESTAMP          | NOT NULL DEFAULT NOW() | Creation timestamp                           |
| updated_at  | TIMESTAMP          | NOT NULL DEFAULT NOW() | Last update timestamp                        |
| PRIMARY KEY | (vault_id, app_id) |                        | One record per user per app                  |

**Example fields JSONB:**

Simple:

```json
{ "username": "nikhil", "password": "secret" }
```

Role-based:

```json
{ "username": "nikhil", "password": "secret", "role": "admin" }
```

### 2.2 audit_log

| Column    | Type      | Constraints            | Description                                                      |
| --------- | --------- | ---------------------- | ---------------------------------------------------------------- |
| id        | SERIAL    | PK                     | Audit ID                                                         |
| vault_id  | TEXT      | NOT NULL               | User vault ID                                                    |
| app_id    | TEXT      | NOT NULL               | App ID (or `*` for delete-vault)                                 |
| action    | TEXT      | NOT NULL               | Action type: `read`, `write`, `update`, `delete`, `delete-vault` |
| timestamp | TIMESTAMP | NOT NULL DEFAULT NOW() | Event timestamp                                                  |

---

## 3. Target Apps (App A-D) — SQLite

**Database:** "Session based App (App A)/database.sqlite", "Session + CSRF App (App B)/database.sqlite", etc.

### 3.1 users (App A, App B, App C, App D)

| Column       | Type    | Constraints      | Description         |
| ------------ | ------- | ---------------- | ------------------- |
| id           | INTEGER | PK AUTOINCREMENT | User ID             |
| username     | TEXT    | UNIQUE NOT NULL  | Login username      |
| password     | TEXT    | NOT NULL         | Plain text password |
| display_name | TEXT    |                  | Display name        |

### 3.2 Additional Tables

#### Role-based login App (App D) (Role-based)

| Column | Type | Constraints | Description |
| ------ | ---- | ----------- | ----------- |
| role   | TEXT | NOT NULL    | User role   |

---

## 4. Data Flow Mapping

### PID ↔ Vault Mapping

| PID Table | PID Column | Vault Table       | Vault Column | Purpose             |
| --------- | ---------- | ----------------- | ------------ | ------------------- |
| users     | id         | vault_credentials | vault_id     | Identity mapping    |
| users     | vault_id   | vault_credentials | vault_id     | Opaque ID for Vault |
| apps      | appId      | vault_credentials | app_id       | App identification  |

### Extension Flow

```
Extension → PID (port 4000) → Vault (port 5000) → PostgreSQL (port 5433)
```

---

## 5. Quick Reference

| Service          | Database   | Port | Tables                                |
| ---------------- | ---------- | ---- | ------------------------------------- |
| Primary Identity | SQLite     | N/A  | users, apps, user_apps, plugin_tokens |
| Vault Service    | PostgreSQL | 5433 | vault_credentials, audit_log          |
| Target Apps      | SQLite     | N/A  | users                                 |
