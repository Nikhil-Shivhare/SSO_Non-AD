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

## API Endpoints

### Session

| Method | Endpoint              | Description   |
| ------ | --------------------- | ------------- |
| GET    | `/login`              | Login page    |
| POST   | `/login`              | Authenticate  |
| GET    | `/logout`             | Logout        |
| GET    | `/api/session/status` | Check session |

### Extension Bootstrap

```bash
# Get plugin token and allowed apps
curl -X POST http://localhost:4000/api/plugin/bootstrap \
  -H "Cookie: PID_SESSION=<session_cookie>"
```

Response:

```json
{
  "pluginToken": "ptk_xxx",
  "expiresIn": 3600,
  "apps": [{ "appId": "app_a", "origin": "http://localhost:3001" }]
}
```

### Token Introspection

```bash
curl -X POST http://localhost:4000/api/token/introspect \
  -H "Content-Type: application/json" \
  -d '{"pluginToken": "ptk_xxx"}'
```

### Vault Credentials

```bash
# Get credentials
curl http://localhost:4000/api/vault/credentials?appId=app_a \
  -H "Authorization: Bearer ptk_xxx"

# Save credentials
curl -X POST http://localhost:4000/api/vault/credentials \
  -H "Authorization: Bearer ptk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"appId": "app_a", "username": "user", "password": "pass"}'
```

## Extension Integration Flow

1. User logs in at `http://localhost:4000/login`
2. Extension calls `POST /api/plugin/bootstrap` with session cookie
3. Server returns `pluginToken` + list of allowed apps
4. Extension stores token and uses it to fetch credentials
5. Extension auto-fills legacy app login forms

## Database

SQLite database stored as `database.sqlite`. Auto-created on first run.

Tables:

- `users` - Primary identity users
- `apps` - Registered legacy apps
- `user_apps` - User ↔ App mapping
- `plugin_tokens` - Extension tokens
- `vault_credentials` - Per-user app credentials

## Security Notes (PoC Only)

- Vault passwords are stored as **plain text**
- In production: encrypt with AES-256-GCM
- pluginToken is a random string
- In production: use JWT with signing
- This component can be replaced with **Keycloak**
