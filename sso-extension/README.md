# SSO Browser Extension

**The Agent** in the SSO architecture. Automatically logs users into legacy web applications using schema-driven credential replay.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Browser Extension                             │
├─────────────────────┬─────────────────────┬─────────────────────┤
│   background.js     │    content.js       │     utils.js        │
│   (The Brain)       │    (The Hands)      │    (Helpers)        │
├─────────────────────┼─────────────────────┼─────────────────────┤
│ • State management  │ • DOM detection     │ • Notifications     │
│ • API calls         │ • Form filling      │ • User consent      │
│ • Session tracking  │ • Learning mode     │ • Logging           │
│ • User isolation    │ • Password change   │                     │
└─────────────────────┴─────────────────────┴─────────────────────┘
```

## Files

| File            | Role          | Responsibility                                    |
| --------------- | ------------- | ------------------------------------------------- |
| `manifest.json` | Config        | Extension permissions, content script matches     |
| `background.js` | **The Brain** | API communication, state, session, user isolation |
| `content.js`    | **The Hands** | DOM interaction, form detection, filling, submit  |
| `utils.js`      | Helpers       | Notifications, consent dialogs, logging           |

---

## State Management (background.js)

The extension maintains a single source of truth:

```javascript
state = {
  pluginToken: null, // Bearer token for API calls
  tokenExpiry: null, // Token expiration timestamp
  apps: [], // [{ appId, origin, loginSchema }]
  currentUserId: null, // For user switch detection
  currentUsername: null, // For logging
};
```

### User Session Isolation

When a different user logs into Primary Identity:

1. Bootstrap compares `userId` from API with `state.currentUserId`
2. If different → **clears all state** (token, apps, user info)
3. Logs: `"User changed: userA -> userB, clearing state"`
4. Prevents credential leakage between users

---

## Message Types (Content ↔ Background)

| Action            | Direction            | Request                     | Response                                |
| ----------------- | -------------------- | --------------------------- | --------------------------------------- |
| `getCredentials`  | Content → Background | `{ origin }`                | `{ success, credentials, loginSchema }` |
| `saveCredentials` | Content → Background | `{ origin, fields: {...} }` | `{ success }`                           |
| `updatePassword`  | Content → Background | `{ origin, newPassword }`   | `{ success }`                           |

### getCredentials Flow

```
Content Script                    Background Script
     │                                  │
     ├─── getCredentials ───────────────►
     │                                  │
     │                    ◄── ensureReady() ──
     │                    │   1. checkSession()
     │                    │   2. bootstrap()
     │                    │   3. fetchCredentials(appId)
     │                                  │
     ◄─── { credentials, loginSchema } ──┤
     │                                  │
```

---

## API Functions (background.js)

| Function                         | API Endpoint                  | Purpose                    |
| -------------------------------- | ----------------------------- | -------------------------- |
| `checkSession()`                 | `GET /api/session/status`     | Verify user logged in      |
| `bootstrap()`                    | `POST /api/plugin/bootstrap`  | Get token + apps + schemas |
| `fetchCredentials(appId)`        | `GET /api/vault/credentials`  | Get stored credentials     |
| `saveCredentials(appId, fields)` | `POST /api/vault/credentials` | Save learned credentials   |
| `updatePassword(appId, newPass)` | `PUT /api/vault/password`     | Update password only       |

### Helper Functions

| Function                         | Purpose                         |
| -------------------------------- | ------------------------------- |
| `getAppIdByOrigin(origin)`       | Find appId from URL origin      |
| `getLoginSchemaByOrigin(origin)` | Get form schema for app         |
| `isAllowedOrigin(origin)`        | Check if origin in allowlist    |
| `isTokenValid()`                 | Check token expiry              |
| `ensureReady()`                  | Guarantee session + token valid |

---

## Content Script Functions (content.js)

### Form Detection

| Function                   | Purpose                            |
| -------------------------- | ---------------------------------- |
| `findLoginForm()`          | Detect username + password inputs  |
| `findPasswordChangeForm()` | Detect current/new password fields |

### Form Actions

| Function                                  | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `fillLoginFormWithSchema(schema, fields)` | **Generic** schema-driven fill            |
| `fillLoginForm(credentials)`              | Legacy fallback (username/password only)  |
| `submitLoginForm()`                       | Auto-submit (button click or form.submit) |

### Learning Mode

| Function                    | Purpose                                   |
| --------------------------- | ----------------------------------------- |
| `enterLearningMode(schema)` | Watch for manual login, capture fields    |
| `captureFormFields(schema)` | Extract values from form based on schema  |
| `checkLearningSuccess()`    | On navigation, prompt to save credentials |

### Password Change

| Function                       | Purpose                              |
| ------------------------------ | ------------------------------------ |
| `handlePasswordChange()`       | Capture new password on submit       |
| `checkPasswordChangeSuccess()` | On navigation, update vault password |

### Session Storage Helpers

| Function                          | Purpose                                 |
| --------------------------------- | --------------------------------------- |
| `saveLearningCredentials(fields)` | Persist captured data across navigation |
| `getLearningCredentials()`        | Retrieve captured data                  |
| `saveLoginSchema(schema)`         | Persist schema for learning             |

---

## Schema-Driven Form Filling

### How It Works

1. **Bootstrap** returns `loginSchema` per app
2. Content script calls `fillLoginFormWithSchema(schema, fields)`
3. Function iterates over schema keys:
   ```javascript
   for (const [fieldName, fieldDef] of Object.entries(schema)) {
     const element = document.querySelector(fieldDef.selector);
     const value = fields[fieldName];

     if (fieldDef.type === "select") {
       element.value = value;
     } else {
       element.value = value;
     }

     element.dispatchEvent(new Event("input", { bubbles: true }));
     element.dispatchEvent(new Event("change", { bubbles: true }));
   }
   ```

### Example Schema (App-D with Role)

```json
{
  "username": { "selector": "input[name='username']", "type": "text" },
  "password": { "selector": "input[name='password']", "type": "password" },
  "role": { "selector": "select[name='role']", "type": "select" }
}
```

### Example Fields

```json
{
  "username": "nikhil",
  "password": "secret",
  "role": "admin"
}
```

---

## Main Flow (content.js → main())

```
Page Load
    │
    ├─► Check password change success (from previous navigation)
    │
    ├─► Check learning success (from previous navigation)
    │
    ├─► Detect password change form?
    │       └─► Yes: handlePasswordChange()
    │
    ├─► Detect login form?
    │       └─► No: Exit
    │
    ├─► Request credentials from background
    │       │
    │       ├─► Credentials found?
    │       │       └─► Yes: fillLoginFormWithSchema() → submit
    │       │
    │       └─► No credentials?
    │               └─► enterLearningMode()
    │
    └─► Done
```

---

## User Notifications (utils.js)

| Event            | Message                                          |
| ---------------- | ------------------------------------------------ |
| SSO Active       | "SSO Active - Logging you in automatically"      |
| First-Time       | "First-Time Login - Please log in manually"      |
| Save Prompt      | "Save credentials for future automatic login?"   |
| Saved            | "Credentials Saved - SSO is now enabled"         |
| Password Updated | "Password Updated - New password saved to vault" |

---

## Installation

### Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select `sso-extension` folder

### Firefox

1. Go to `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on**
4. Select `manifest.json`

---

## Allowed Origins

Configured in `manifest.json`:

| Origin                    | App               |
| ------------------------- | ----------------- |
| `http://localhost:3001/*` | App-A             |
| `http://localhost:3002/*` | App-B             |
| `http://localhost:3003/*` | App-C             |
| `http://localhost:3004/*` | App-D (with role) |
| `http://localhost:4000/*` | Primary Identity  |

---

## Security Notes (PoC Only)

> ⚠️ **Proof of Concept Limitations**

- Credentials stored in memory only (not persisted)
- No encryption of data in transit beyond HTTPS
- Session check runs before every sensitive action
- Logout from Primary Identity immediately invalidates extension

### Production Hardening (Deferred)

- Retry logic with exponential backoff
- Rate limiting
- MFA handling
- Keycloak integration
- Token refresh scheduling
