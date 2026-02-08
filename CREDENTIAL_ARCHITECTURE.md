# Credential Storage Architecture - Deep Analysis

## Answer: Credentials are stored **INSIDE** Primary Identity Service

The credential vault is **NOT separate** - it is a **built-in part** of Primary Identity service.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                    PRIMARY IDENTITY SERVICE                     │
│                    (http://localhost:4000)                      │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │              SQLite Database (database.sqlite)            │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  • users                  (Primary Identity users)        │  │
│  │  • apps                   (App registry)                  │  │
│  │  • user_apps              (Access control)                │  │
│  │  • plugin_tokens          (Extension auth)                │  │
│  │  • vault_credentials ← CREDENTIALS STORED HERE            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     API Endpoints                         │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  /api/session/status       (Check login)                 │  │
│  │  /api/plugin/bootstrap     (Get token)                   │  │
│  │  /api/vault/credentials    (Get/Save credentials) ←      │  │
│  │  /api/vault/password       (Update password)      ←      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

---

## Database Schema - vault_credentials Table

Located in: `primary-identity/database.sqlite`

```sql
CREATE TABLE vault_credentials (
    user_id INTEGER,
    app_id INTEGER,
    app_username TEXT NOT NULL,
    app_password TEXT NOT NULL,        -- ⚠️ PLAIN TEXT (PoC only)
    extra_fields TEXT DEFAULT NULL,    -- JSON for role, etc.
    PRIMARY KEY (user_id, app_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (app_id) REFERENCES apps(id)
);
```

### Example Data:

```
user_id | app_id | app_username | app_password | extra_fields
--------|--------|--------------|--------------|------------------
2       | 1      | testuser     | TestPass123! | NULL
2       | 4      | nikhil       | nikhil       | {"role":"admin"}
9       | 1      | rajA         | rajAA        | NULL
```

---

## Complete Flow: Credential Storage & Retrieval

### Flow 1: **Saving Credentials (Learning Mode)**

```
User logs into App-1 manually
          ↓
Content Script captures: { username: "rajA", password: "rajAA" }
          ↓
chrome.runtime.sendMessage({
    action: 'saveCredentials',
    origin: 'http://localhost:3001',
    fields: { username: "rajA", password: "rajAA" }
})
          ↓
Background Script (sso-extension/background.js)
    ├─ Has pluginToken? Yes
    ├─ Find appId for origin: app_id = 1
    └─ Call Primary Identity API:
          ↓
POST http://localhost:4000/api/vault/credentials
Authorization: Bearer <pluginToken>
Body: {
    appId: "1",
    username: "rajA",
    password: "rajAA"
}
          ↓
Primary Identity (app.js)
    ├─ Validate token (check plugin_tokens table)
    ├─ Get user_id from token: user_id = 9
    ├─ Check user has access to app_id=1 (user_apps table)
    └─ Call db.saveVaultCredentials()
          ↓
Database (db.js)
    └─ INSERT/REPLACE INTO vault_credentials
       (user_id, app_id, app_username, app_password)
       VALUES (9, 1, 'rajA', 'rajAA')
          ↓
✅ Credential saved in PRIMARY IDENTITY database
```

### Flow 2: **Retrieving Credentials (Auto-Login)**

```
User visits App-1 login page
          ↓
Content Script detects login form
          ↓
chrome.runtime.sendMessage({
    action: 'getCredentials',
    origin: 'http://localhost:3001'
})
          ↓
Background Script
    ├─ Check session: GET /api/session/status
    ├─ Bootstrap if needed: POST /api/plugin/bootstrap
    ├─ Find appId for origin: app_id = 1
    └─ Call Primary Identity API:
          ↓
GET http://localhost:4000/api/vault/credentials?appId=1
Authorization: Bearer <pluginToken>
          ↓
Primary Identity (app.js)
    ├─ Validate token (user_id = 9)
    ├─ Check user has access to app_id=1
    └─ Call db.getVaultCredentials(user_id=9, app_id=1)
          ↓
Database (db.js)
    └─ SELECT app_username, app_password, extra_fields
       FROM vault_credentials
       WHERE user_id=9 AND app_id=1
          ↓
Return: { username: "rajA", password: "rajAA" }
          ↓
Background → Content Script
          ↓
Content Script fills form and submits
          ↓
✅ User logged into App-1 automatically
```

---

## File Locations

| Component          | File                               | Contains                                          |
| ------------------ | ---------------------------------- | ------------------------------------------------- |
| **Database**       | `primary-identity/database.sqlite` | `vault_credentials` table                         |
| **Database Logic** | `primary-identity/db.js`           | `saveVaultCredentials()`, `getVaultCredentials()` |
| **API Layer**      | `primary-identity/app.js`          | `/api/vault/*` endpoints                          |
| **Extension**      | `sso-extension/background.js`      | Calls vault APIs                                  |

---

## Security Model (PoC)

### ⚠️ Current Implementation (NOT Production-Ready)

| Layer          | Security                       |
| -------------- | ------------------------------ |
| Storage        | Plain text passwords in SQLite |
| Transport      | HTTP (no HTTPS)                |
| Token          | Simple random string (not JWT) |
| Access Control | Basic user_id + app_id check   |

### 🔒 Production Requirements

| Layer          | Should Be                                           |
| -------------- | --------------------------------------------------- |
| Storage        | Encrypted at rest (AES-256)                         |
| Transport      | HTTPS only                                          |
| Token          | JWT with exp, iss, aud claims                       |
| Access Control | OAuth scopes, RBAC                                  |
| Vault          | Separate service (HashiCorp Vault, Azure Key Vault) |

---

## Why Credentials are Inside Primary Identity?

### Current Architecture (PoC):

✅ **Pros:**

- Simple to implement
- Fast prototyping
- Single service to run
- No external dependencies

❌ **Cons:**

- Not scalable
- Single point of failure
- Cannot replace identity provider without migrating vault
- Passwords in plain text

### Production Architecture (Future):

```
┌─────────────────────┐      ┌─────────────────────┐
│   Keycloak/Okta     │      │  HashiCorp Vault    │
│  (Identity Provider)│      │  (Credential Store) │
├─────────────────────┤      ├─────────────────────┤
│ • User auth         │      │ • Encrypted storage │
│ • Session mgmt      │      │ • Access policies   │
│ • Token issuance    │      │ • Audit logs        │
└─────────────────────┘      └─────────────────────┘
          ↑                            ↑
          │                            │
          └────────────────┬───────────┘
                           │
                  ┌────────▼─────────┐
                  │  SSO Extension   │
                  └──────────────────┘
```

---

## Key Takeaways

1. **Credentials are stored in Primary Identity's SQLite database**
   - Table: `vault_credentials`
   - Location: `primary-identity/database.sqlite`

2. **Primary Identity provides Vault APIs**
   - `GET /api/vault/credentials` - Retrieve
   - `POST /api/vault/credentials` - Save
   - `PUT /api/vault/password` - Update

3. **Extension only calls APIs, never touches database directly**
   - Background script → API calls → Database

4. **All access is controlled by plugin tokens**
   - Token maps to user_id
   - User must have access in `user_apps` table

5. **For production: Separate vault service recommended**
   - HashiCorp Vault
   - Azure Key Vault
   - AWS Secrets Manager
