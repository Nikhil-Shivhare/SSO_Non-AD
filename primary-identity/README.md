# Primary Identity Service

Minimal PoC identity provider for SSO browser extension.

## Quick Start

```bash
cd primary-identity
npm install
npm start
```

Server runs at: **http://localhost:4000**

## Demo Credentials

| Username | Password     | Role  |
| -------- | ------------ | ----- |
| admin    | admin123     | Admin |
| testuser | TestPass123! | User  |

## Features

- User authentication with session cookies
- Admin panel for user/app management
- Extension bootstrap API
- Vault credential storage
- Token introspection

## API Reference

### Complete API Table

| Method             | Endpoint                         | Auth                 | Interacts With | Description                                                              |
| ------------------ | -------------------------------- | -------------------- | -------------- | ------------------------------------------------------------------------ |
| **Session & Auth** |                                  |                      |                |                                                                          |
| GET                | `/login`                         | None                 | Browser        | Displays login page                                                      |
| POST               | `/login`                         | None                 | Browser → DB   | Authenticates user, creates session                                      |
| GET                | `/logout`                        | Session              | Browser        | Revokes all plugin tokens, destroys session, redirects to login          |
| GET                | `/api/session/status`            | Session Cookie       | Extension      | Returns `{authenticated: true/false, userId, username, role}`            |
| **Extension APIs** |                                  |                      |                |                                                                          |
| POST               | `/api/plugin/bootstrap`          | Session Cookie       | Extension → DB | Returns `pluginToken`, `userId`, `username`, `apps[]` with `loginSchema` |
| POST               | `/api/token/introspect`          | None (token in body) | Extension      | Validates pluginToken, returns user info and scopes                      |
| **Vault APIs**     |                                  |                      |                |                                                                          |
| GET                | `/api/vault/credentials?appId=X` | Bearer Token         | Extension → DB | Returns `{fields: {username, password, role?}}`                          |
| POST               | `/api/vault/credentials`         | Bearer Token         | Extension → DB | Saves credentials with `{appId, fields: {...}}`                          |
| PUT                | `/api/vault/password`            | Bearer Token         | Extension → DB | Updates only password, preserves other fields                            |
| **Admin APIs**     |                                  |                      |                |                                                                          |
| GET                | `/admin`                         | Session (Admin)      | Browser        | Admin panel page                                                         |
| POST               | `/admin/users`                   | Session (Admin)      | Browser → DB   | Create new user                                                          |
| POST               | `/admin/users/:id/delete`        | Session (Admin)      | Browser → DB   | Delete user                                                              |
| POST               | `/admin/assign-app`              | Session (Admin)      | Browser → DB   | Assign app to user                                                       |
| POST               | `/admin/remove-app`              | Session (Admin)      | Browser → DB   | Remove app from user                                                     |
| **Pages**          |                                  |                      |                |                                                                          |
| GET                | `/`                              | None                 | Browser        | Redirects to `/login`                                                    |
| GET                | `/dashboard`                     | Session              | Browser        | User dashboard with assigned apps                                        |

### Authentication Types

| Type               | Description                     | Used By                |
| ------------------ | ------------------------------- | ---------------------- |
| **Session Cookie** | `PID_SESSION` HTTP-only cookie  | Browser, Admin Panel   |
| **Bearer Token**   | `Authorization: Bearer ptk_xxx` | Extension Vault APIs   |
| **None**           | Public endpoint                 | Login page, Introspect |

### Extension Bootstrap Flow

```bash
# 1. Bootstrap - Get token and app schemas
curl -X POST http://localhost:4000/api/plugin/bootstrap \
  -H "Cookie: PID_SESSION=<session_cookie>"
```

**Response:**

```json
{
  "pluginToken": "ptk_xxx",
  "expiresIn": 3600,
  "userId": 2,
  "username": "testuser",
  "apps": [
    {
      "appId": "app_d",
      "origin": "http://localhost:3004",
      "loginSchema": {
        "username": { "selector": "input[name='username']", "type": "text" },
        "password": {
          "selector": "input[name='password']",
          "type": "password"
        },
        "role": { "selector": "select[name='role']", "type": "select" }
      }
    }
  ]
}
```

### Vault Credential APIs

```bash
# Get credentials (with extra fields like role)
curl http://localhost:4000/api/vault/credentials?appId=app_d \
  -H "Authorization: Bearer ptk_xxx"
```

**Response:**

```json
{
  "appId": "app_d",
  "fields": {
    "username": "nikhil",
    "password": "secret",
    "role": "admin"
  }
}
```

```bash
# Save credentials (with extra fields)
curl -X POST http://localhost:4000/api/vault/credentials \
  -H "Authorization: Bearer ptk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"appId": "app_d", "fields": {"username": "user", "password": "pass", "role": "intern"}}'

# Update password only (preserves role)
curl -X PUT http://localhost:4000/api/vault/password \
  -H "Authorization: Bearer ptk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"appId": "app_d", "newPassword": "newpass"}'
```

## Database

SQLite database stored as `database.sqlite`. Auto-created on first run.

| Table               | Description                                                             |
| ------------------- | ----------------------------------------------------------------------- |
| `users`             | Primary Identity users (id, username, password_hash, role)              |
| `apps`              | Registered apps (id, appId, origin, **login_schema**)                   |
| `user_apps`         | User ↔ App access control                                               |
| `plugin_tokens`     | Extension tokens (token, user_id, scopes, expires_at)                   |
| `vault_credentials` | Per-user app credentials (app_username, app_password, **extra_fields**) |

## Security Notes (PoC Only)

- Vault passwords are stored as **plain text**
- In production: encrypt with AES-256-GCM
- pluginToken is a random string
- In production: use JWT with signing
- This component can be replaced with **Keycloak**

## View All Credentials (SQL)

```bash
sqlite3 database.sqlite "SELECT u.username, vc.app_id, vc.app_username, vc.app_password, vc.extra_fields FROM vault_credentials vc JOIN users u ON vc.user_id = u.id;"
```

```bash
sqlite3 database.sqlite "SELECT * FROM vault_credentials;"
```
