# 🔐 Non-AD SSO — Single Sign-On for Legacy Web Applications

> **A browser extension-based SSO solution that enables automatic login to legacy web applications that don't support modern identity protocols (SAML, OAuth, OIDC).**

Built as a Proof of Concept to demonstrate how organizations can bring SSO capabilities to legacy web apps **without modifying the apps themselves**.

---

## 📋 Table of Contents

- [Problem Statement](#-problem-statement)
- [Solution Overview](#-solution-overview)
- [Architecture](#-architecture)
- [Project Structure](#-project-structure)
- [Tech Stack](#-tech-stack)
- [Getting Started](#-getting-started)
- [Demo Applications](#-demo-applications)
- [SSO Extension Features](#-sso-extension-features)
- [Primary Identity Service](#-primary-identity-service)
- [Credential Architecture](#-credential-architecture)
- [API Reference](#-api-reference)
- [How It Works — Detailed Flows](#-how-it-works--detailed-flows)
- [Security Notes](#-security-notes)
- [Future Roadmap](#-future-roadmap)

---

## 🎯 Problem Statement

Many enterprises have **legacy web applications** that:

- Use traditional session-based authentication (username/password forms)
- Don't support modern identity standards (SAML, OAuth 2.0, OIDC)
- Cannot be modified to integrate with identity providers like Keycloak or Okta
- Are not Active Directory (AD) integrated

**Challenge**: How do you provide SSO to these apps without changing their code?

---

## 💡 Solution Overview

A **Chrome browser extension** that acts as an intelligent agent:

1. **Observes** — Detects login forms on legacy web applications
2. **Learns** — Captures credentials on first manual login (Learning Mode)
3. **Replays** — Automatically fills and submits login forms on subsequent visits
4. **Syncs** — Keeps credentials updated when passwords change

All credentials are stored centrally in a **Primary Identity Service** (credential vault), which the extension communicates with through REST APIs.

```
┌──────────────┐      ┌───────────────────────┐      ┌─────────────────┐
│   User's     │      │   Primary Identity    │      │  Legacy Apps    │
│   Browser    │      │   Service             │      │  (Unmodified)   │
│              │      │   (http://localhost:  │      │                 │
│  ┌────────┐  │ API  │    4000)              │      │  App-A (:3001)  │
│  │  SSO   │◄─┼──────┤                       │      │  App-B (:3002)  │
│  │ Ext.   │  │      │  • User auth          │      │  App-C (:3003)  │
│  │        │──┼──────►  • Credential vault   │      │  App-D (:3004)  │
│  └────────┘  │      │  • App registry       │      │                 │
│       │      │      │  • Login schemas      │      │                 │
│       │      │      └───────────────────────┘      │                 │
│       ▼      │                                     │                 │
│  Auto-fill   ├────────────────────────────────────►│   Login forms   │
│  & submit    │                                     │   auto-filled   │
└──────────────┘                                     └─────────────────┘
```

---

## 🏗 Architecture

### System Components

```
┌────────────────────────────────────────────────────────────────────────┐
│                        NON-AD SSO SYSTEM                               │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ PRIMARY IDENTITY SERVICE (Port 4000)                            │  │
│  │                                                                  │  │
│  │  ┌──────────────────┐  ┌────────────────────────────────────┐  │  │
│  │  │  SQLite Database  │  │  API Layer                         │  │  │
│  │  │   ┌─ users       │  │   /api/session/status              │  │  │
│  │  │   ├─ apps        │  │   /api/plugin/bootstrap            │  │  │
│  │  │   ├─ user_apps   │  │   /api/vault/credentials           │  │  │
│  │  │   ├─ plugin_tokens│  │   /api/vault/password              │  │  │
│  │  │   └─ vault_creds │  │   /api/token/introspect            │  │  │
│  │  └──────────────────┘  └────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ SSO BROWSER EXTENSION                                           │  │
│  │                                                                  │  │
│  │  background.js  ──  API calls, state, session, user isolation  │  │
│  │  content.js     ──  DOM detection, form filling, learning mode │  │
│  │  utils.js       ──  Notifications, consent dialogs, logging    │  │
│  │  manifest.json  ──  Permissions, content script matches        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │ App-A (:3001)│ │ App-B (:3002)│ │ App-C (:3003)│ │ App-D (:3004)│ │
│  │ Session-based│ │ Session+CSRF │ │ Stateless    │ │ Role-based   │ │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘ │
│                                                                        │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │ LAUNCHER (Port 3100) — Navigation UI to launch all apps        │  │
│  └─────────────────────────────────────────────────────────────────┘  │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
TEST3(new start)/
│
├── primary-identity/          # Central identity & credential vault service
│   ├── app.js                 # Express server with all API endpoints
│   ├── db.js                  # SQLite database setup, seed data, queries
│   ├── database.sqlite        # Auto-generated database file
│   ├── package.json           # Dependencies
│   └── README.md              # Primary Identity documentation
│
├── sso-extension/             # Chrome browser extension
│   ├── manifest.json          # Extension configuration (Manifest V3)
│   ├── background.js          # Service worker — API calls, state management
│   ├── content.js             # Content script — DOM interaction, form filling
│   ├── utils.js               # Shared utilities — notifications, logging
│   ├── icon.png               # Extension icon
│   └── README.md              # Extension documentation
│
├── APP1/                      # Demo: Session-based app (port 3001)
│   ├── app.js                 # Express server with session auth
│   ├── users.db               # SQLite user database
│   └── package.json
│
├── APP2/                      # Demo: Session + CSRF app (port 3002)
│   ├── app.js                 # Express server with CSRF protection
│   ├── users.db
│   └── package.json
│
├── APP3/                      # Demo: Stateless app (port 3003)
│   ├── app.js                 # No session — login on every page load
│   ├── users.db
│   └── package.json
│
├── APP4/                      # Demo: Role-based login app (port 3004)
│   ├── app.js                 # Login form with role selector
│   ├── users.db
│   └── package.json
│
├── launcher/                  # App launcher UI (port 3100)
│   └── app.js                 # Simple Express server with navigation links
│
├── start-all.sh               # Start all services at once
├── stop-all.sh                # Stop all services
├── CREDENTIAL_ARCHITECTURE.md # Detailed credential storage documentation
├── CREDENTIAL_SCHEMA.md       # Schema-driven credential format docs
├── COMMANDS.md                # Useful commands reference
└── README.md                  # ← You are here
```

---

## 🛠 Tech Stack

| Component         | Technology                   |
| ----------------- | ---------------------------- |
| Backend           | Node.js + Express            |
| Database          | SQLite3                      |
| Authentication    | express-session + bcrypt     |
| Browser Extension | Chrome Extension Manifest V3 |
| Language          | JavaScript                   |
| CSRF Protection   | csurf (App-B)                |

---

## 🚀 Getting Started

### Prerequisites

- **Node.js** v16+ installed
- **Google Chrome** browser
- **SQLite3** (for debugging/inspection, optional)

### 1. Install Dependencies

```bash
# Install all dependencies at once
cd primary-identity && npm install && cd ..
cd APP1 && npm install && cd ..
cd APP2 && npm install && cd ..
cd APP3 && npm install && cd ..
cd APP4 && npm install && cd ..
cd launcher && npm install && cd ..
```

### 2. Start All Services

```bash
./start-all.sh
```

This starts all 6 services:

| Service          | URL                   | Port |
| ---------------- | --------------------- | ---- |
| Primary Identity | http://localhost:4000 | 4000 |
| App-A            | http://localhost:3001 | 3001 |
| App-B            | http://localhost:3002 | 3002 |
| App-C            | http://localhost:3003 | 3003 |
| App-D            | http://localhost:3004 | 3004 |
| Launcher         | http://localhost:3100 | 3100 |

### 3. Install the Browser Extension

1. Open Chrome → Navigate to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `sso-extension/` folder
5. The extension icon appears in the toolbar ✓

### 4. Test the Flow

1. **Login to Primary Identity**: http://localhost:4000/login
   - Username: `testuser` | Password: `TestPass123!`
2. **Open Launcher**: http://localhost:3100
3. **Click any app** (e.g., App-A)
4. **First time**: Extension enters Learning Mode → Login manually → Save credentials
5. **Next time**: Extension auto-fills and logs in **silently** ✅

### Stop All Services

```bash
./stop-all.sh
```

---

## 🖥 Demo Applications

Four demo apps simulate different real-world legacy authentication scenarios:

| App   | Port | Auth Type              | Challenge for SSO                                    |
| ----- | ---- | ---------------------- | ---------------------------------------------------- |
| App-A | 3001 | Session-based          | Standard login — baseline case                       |
| App-B | 3002 | Session + CSRF         | CSRF token required — extension must handle          |
| App-C | 3003 | Stateless (no session) | Login required on every page refresh                 |
| App-D | 3004 | Role-based login       | Extra field (role dropdown) beyond username/password |

### Demo User Accounts

Each app has its own SQLite database with independent user accounts. Register new users or use the ones created during testing.

---

## 🔌 SSO Extension Features

### ✅ Smart Auto-Login (Silent Mode)

The extension attempts to login **silently** — no prompts when credentials are correct.

```
Page loads → Login form detected
              ↓
      ┌─ Credentials found? ─┐
      │                      │
      No                    Yes
      ↓                      ↓
  Learning Mode       Try SILENT auto-login
                             ↓
                     ┌─ Success? ─┐
                     │            │
                    Yes          No
                     ↓            ↓
               Navigate away   Show options:
               (no popups!)    1 = Retry
                               2 = Manual
                               3 = Update
```

### ✅ Learning Mode (First-Time Credential Capture)

When no saved credentials exist for an app:

1. Extension detects login form
2. Enters "Learning Mode" — watches for manual login
3. User logs in normally
4. Extension captures credentials and saves to vault
5. Future visits auto-login silently

### ✅ Schema-Driven Form Filling

Each app can have a unique login schema defining its form fields:

```json
// App-D Schema (username + password + role dropdown)
{
  "username": { "selector": "input[name='username']", "type": "text" },
  "password": { "selector": "input[name='password']", "type": "password" },
  "role": { "selector": "select[name='role']", "type": "select" }
}
```

This allows the extension to fill **any form shape** — not just username/password.

### ✅ Password Change Detection

When a user changes their password in any app:

1. Extension detects the password change form (`/change-password`)
2. Captures the new password on form submit
3. Watches for success message on the page
4. **Automatically updates** the vault — no manual intervention needed
5. Shows notification: "Password Updated"

### ✅ User Session Isolation

When a different user logs into Primary Identity:

1. Extension detects user change
2. Clears ALL previous state (token, apps, credentials)
3. Triggers **Cascade Logout** — logs out from all apps where SSO happened
4. Prevents credential leakage between users

### ✅ Cascade Logout

| Step | Action                                                            |
| ---- | ----------------------------------------------------------------- |
| 1    | User A logs in → visits App-A, App-B (SSO auto-fills)             |
| 2    | Extension tracks: `loggedInApps = [App-A, App-B]`                 |
| 3    | User B logs into Primary Identity                                 |
| 4    | Extension detects user change                                     |
| 5    | Extension opens `App-A/logout`, `App-B/logout` in background tabs |
| 6    | All User A sessions terminated! ✓                                 |

---

## 🏛 Primary Identity Service

The central service that manages users, apps, and credentials.

### Admin Panel

Access at: http://localhost:4000/admin (login as `admin` / `admin123`)

**Admin can:**

- Create / delete users
- Register / manage applications
- Assign apps to users
- View all credential mappings

### Database Tables

| Table               | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `users`             | Primary Identity user accounts (id, username, password_hash, role)      |
| `apps`              | Registered apps (appId, origin, login_schema as JSON)                   |
| `user_apps`         | User ↔ App access control mapping                                       |
| `plugin_tokens`     | Extension authentication tokens (token, user_id, scopes, expires_at)    |
| `vault_credentials` | Per-user per-app credentials (app_username, app_password, extra_fields) |

---

## 🗄 Credential Architecture

Credentials are stored **inside** the Primary Identity service — in the same SQLite database.

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
│  │  • vault_credentials  ←── CREDENTIALS STORED HERE         │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                     Vault API Endpoints                   │  │
│  ├──────────────────────────────────────────────────────────┤  │
│  │  GET  /api/vault/credentials    (Retrieve credentials)   │  │
│  │  POST /api/vault/credentials    (Save credentials)       │  │
│  │  PUT  /api/vault/password       (Update password)        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Saving:      Extension  →  POST /api/vault/credentials  →  SQLite vault_credentials
Retrieving:  Extension  →  GET  /api/vault/credentials  →  SQLite vault_credentials
Updating:    Extension  →  PUT  /api/vault/password      →  SQLite vault_credentials
```

> 📖 See [CREDENTIAL_ARCHITECTURE.md](CREDENTIAL_ARCHITECTURE.md) for detailed flow diagrams.

---

## 📡 API Reference

### Session & Auth

| Method | Endpoint              | Auth           | Description                          |
| ------ | --------------------- | -------------- | ------------------------------------ |
| GET    | `/login`              | None           | Displays login page                  |
| POST   | `/login`              | None           | Authenticates user, creates session  |
| GET    | `/logout`             | Session        | Destroys session, redirects to login |
| GET    | `/api/session/status` | Session Cookie | Returns `{active: true/false}`       |

### Extension APIs

| Method | Endpoint                | Auth           | Description                                   |
| ------ | ----------------------- | -------------- | --------------------------------------------- |
| POST   | `/api/plugin/bootstrap` | Session Cookie | Returns pluginToken, userId, username, apps[] |
| POST   | `/api/token/introspect` | None           | Validates pluginToken, returns user info      |

### Vault APIs

| Method | Endpoint                         | Auth         | Description                                 |
| ------ | -------------------------------- | ------------ | ------------------------------------------- |
| GET    | `/api/vault/credentials?appId=X` | Bearer Token | Returns `{fields: {username, password...}}` |
| POST   | `/api/vault/credentials`         | Bearer Token | Saves credentials with `{appId, fields}`    |
| PUT    | `/api/vault/password`            | Bearer Token | Updates only password, preserves extras     |

### Bootstrap Response Example

```json
{
  "pluginToken": "ptk_a1b2c3...",
  "expiresIn": 3600,
  "userId": 2,
  "username": "testuser",
  "apps": [
    {
      "appId": "1",
      "origin": "http://localhost:3001",
      "loginSchema": {
        "username": { "selector": "input[name='username']", "type": "text" },
        "password": { "selector": "input[name='password']", "type": "password" }
      }
    },
    {
      "appId": "4",
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

---

## 🔄 How It Works — Detailed Flows

### Flow 1: First-Time Login (Learning Mode)

```
User visits App-A (http://localhost:3001/login)
    │
    ├──► Extension detects login form
    │
    ├──► Requests credentials from background script
    │       └── Background calls: GET /api/vault/credentials?appId=1
    │           └── No credentials found for this user + app
    │
    ├──► Enters Learning Mode
    │       └── "Please log in manually. Credentials will be saved."
    │
    ├──► User types username & password → clicks Login
    │
    ├──► Extension captures form values
    │
    ├──► Page navigates to dashboard (login success)
    │
    ├──► Extension detects: "No longer on login page = success!"
    │
    ├──► Prompts: "Save credentials for future automatic login?"
    │       └── User clicks OK
    │
    └──► Background calls: POST /api/vault/credentials
            └── Credentials saved to vault ✅
```

### Flow 2: Silent Auto-Login (Subsequent Visits)

```
User visits App-A (http://localhost:3001/login)
    │
    ├──► Extension detects login form
    │
    ├──► Requests credentials from background script
    │       └── Background calls: GET /api/vault/credentials?appId=1
    │           └── Returns: { username: "rajA", password: "rajAA" }
    │
    ├──► Extension fills form using schema:
    │       document.querySelector("input[name='username']").value = "rajA"
    │       document.querySelector("input[name='password']").value = "rajAA"
    │
    ├──► Extension submits form (button click or form.submit())
    │
    └──► Page navigates to dashboard — DONE! ✅
            (No popups, no prompts, completely silent)
```

### Flow 3: Auto-Login Failed

```
User visits App-A → Extension fills credentials → Submits
    │
    ├──► Page stays on login page (wrong password!)
    │
    ├──► Extension detects: "Still on login page = FAILED"
    │
    └──► Shows prompt:
         "SSO: Auto-login failed (credentials may be incorrect)"
         1 = Retry auto-login
         2 = Type manually (skip SSO)
         3 = Update credentials (login manually and save new)
```

### Flow 4: Password Change Sync

```
User navigates to App-A /change-password
    │
    ├──► Extension detects password change form
    │
    ├──► User fills current & new password → Submits
    │
    ├──► Extension captures new password value
    │
    ├──► Watches for success message on page...
    │       └── Detects: "Password changed successfully!"
    │
    ├──► Automatically calls: PUT /api/vault/password
    │       └── Vault updated with new password ✅
    │
    └──► Shows notification: "Password Updated"
```

### Flow 5: User Switch + Cascade Logout

```
User A is logged into Primary Identity
    └── SSO filled credentials on App-A, App-B
    └── Extension tracks: loggedInApps = [App-A, App-B]

User A logs out → User B logs into Primary Identity
    │
    ├──► Extension detects user change (userId changed)
    │
    ├──► Clears ALL state (token, apps, credentials)
    │
    ├──► CASCADE LOGOUT:
    │       Opens http://localhost:3001/logout (background tab → close)
    │       Opens http://localhost:3002/logout (background tab → close)
    │
    └──► User A's sessions terminated on ALL apps ✅
         User B starts fresh with their own credentials
```

---

## 🔒 Security Notes

> ⚠️ **This is a Proof of Concept — NOT production-ready**

### Current PoC Limitations

| Layer            | Current (PoC)                  | Production Requirement                |
| ---------------- | ------------------------------ | ------------------------------------- |
| Password Storage | **Plain text** in SQLite       | Encrypted at rest (AES-256-GCM)       |
| Transport        | HTTP (localhost)               | HTTPS with TLS 1.3                    |
| Auth Tokens      | Random string (`ptk_xxx`)      | JWT with signing + expiry + claims    |
| Access Control   | Basic user_id + app_id check   | OAuth 2.0 scopes + RBAC               |
| Credential Vault | Embedded in Primary Identity   | HashiCorp Vault / AWS Secrets Manager |
| Session Mgmt     | Express session (memory store) | Redis-backed session store            |

### Security Features Implemented

- ✅ User session isolation (prevents credential leakage)
- ✅ Cascade logout on user switch
- ✅ Token-based API authentication
- ✅ User→App access control (user_apps mapping)
- ✅ Session validation before every sensitive operation
- ✅ CSRF protection (App-B demonstrates this)

---

## 🗺 Future Roadmap

### Production Hardening

- [ ] Replace Primary Identity with **Keycloak** integration
- [ ] Move credential vault to **HashiCorp Vault** or **Azure Key Vault**
- [ ] Encrypt passwords at rest (AES-256-GCM)
- [ ] Use **JWT** tokens with proper signing and claims
- [ ] Add HTTPS/TLS support
- [ ] Redis-backed session store

### Feature Enhancements

- [ ] MFA (Multi-Factor Authentication) handling
- [ ] Token refresh scheduling with exponential backoff
- [ ] Rate limiting on API endpoints
- [ ] Extension popup UI for status and settings
- [ ] Support for more form types (OTP, captcha bypass, etc.)
- [ ] Audit logging for credential access
- [ ] Bulk credential import/export

### Scalability

- [ ] Support for multiple browser profiles
- [ ] Enterprise deployment via Chrome policies (managed extensions)
- [ ] Support for iframed login forms
- [ ] Cross-browser support (Firefox, Edge)

---

## 📊 Useful Commands

### View All Stored Credentials

```bash
sqlite3 primary-identity/database.sqlite \
  "SELECT u.username, vc.app_id, vc.app_username, vc.app_password, vc.extra_fields \
   FROM vault_credentials vc JOIN users u ON vc.user_id = u.id;"
```

### View Logs

```bash
tail -f /tmp/primary-identity.log   # Primary Identity
tail -f /tmp/app1.log               # App-A
tail -f /tmp/app2.log               # App-B
tail -f /tmp/app3.log               # App-C
tail -f /tmp/app4.log               # App-D
```

### Manage Services

```bash
./start-all.sh          # Start all services
./stop-all.sh           # Stop all services
pkill -f 'node app.js'  # Force kill all Node processes
```

---

## 📜 License

This project is a Proof of Concept developed for internal evaluation purposes.

---

## 👤 Author

**Nikhil Shivhare**

Built at **Accops** as a demonstration of Non-AD SSO capabilities for legacy web applications.
