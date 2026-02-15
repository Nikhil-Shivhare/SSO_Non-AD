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
- Token introspection
- User ↔ App access control

## API Reference

### Complete API Table

| Method             | Endpoint                         | Auth                 | Description                                                              |
| ------------------ | -------------------------------- | -------------------- | ------------------------------------------------------------------------ |
| **Session & Auth** |                                  |                      |                                                                          |
| GET                | `/login`                         | None                 | Displays login page                                                      |
| POST               | `/login`                         | None                 | Authenticates user, creates session                                      |
| GET                | `/logout`                        | Session              | Revokes all plugin tokens, destroys session, redirects to login          |
| GET                | `/api/session/status`            | Session Cookie       | Returns `{authenticated: true/false, userId, username, role}`            |
| **Extension APIs** |                                  |                      |                                                                          |
| POST               | `/api/plugin/bootstrap`          | Session Cookie       | Returns `pluginToken`, `userId`, `username`, `apps[]` with `loginSchema` |
| POST               | `/api/token/introspect`          | None (token in body) | Validates pluginToken, returns user info and scopes                      |
| GET                | `/api/vault/credentials?appId=X` | Bearer Token         | Proxy to Vault Service - Returns credentials                             |
| POST               | `/api/vault/credentials`         | Bearer Token         | Proxy to Vault Service - Save credentials                                |
| PUT                | `/api/vault/password`            | Bearer Token         | Proxy to Vault Service - Update password                                 |
| **Admin APIs**     |                                  |                      |                                                                          |
| GET                | `/admin`                         | Session (Admin)      | Admin panel page                                                         |
| POST               | `/admin/users`                   | Session (Admin)      | Create new user                                                          |
| POST               | `/admin/users/:id/delete`        | Session (Admin)      | Delete user                                                              |
| POST               | `/admin/assign-app`              | Session (Admin)      | Assign app to user                                                       |
| POST               | `/admin/remove-app`              | Session (Admin)      | Remove app from user                                                     |
| **Pages**          |                                  |                      |                                                                          |
| GET                | `/`                              | None                 | Redirects to `/login`                                                    |
| GET                | `/dashboard`                     | Session              | User dashboard with assigned apps                                        |

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

## Database

SQLite database stored as `database.sqlite`. Auto-created on first run.

| Table           | Description                                                          |
| --------------- | -------------------------------------------------------------------- |
| `users`         | Primary Identity users (id, username, password_hash, role, vault_id) |
| `apps`          | Registered apps (id, appId, origin, login_schema)                    |
| `user_apps`     | User ↔ App access control                                            |
| `plugin_tokens` | Extension tokens (token, user_id, scopes, expires_at)                |

## View Users (SQL)

```bash
sqlite3 database.sqlite "SELECT id, username, role, vault_id FROM users;"
```

```bash
sqlite3 database.sqlite "SELECT * FROM users;"
```
