# SSO Extension

Minimal Chrome/Firefox extension for Single Sign-On using credential replay.

## Overview

This extension automatically logs users into legacy web applications by:

1. Detecting login forms on allowlisted apps
2. Fetching stored credentials from Primary Identity vault
3. Auto-filling and submitting the form
4. Learning new credentials on first-time login

## Files

| File            | Purpose                             |
| --------------- | ----------------------------------- |
| `manifest.json` | Extension configuration (MV3)       |
| `background.js` | API communication, state management |
| `content.js`    | DOM interaction, form handling      |
| `utils.js`      | Helper functions                    |

## Requirements

- **Primary Identity** running at `http://localhost:4000`
- **Legacy Apps** running at `http://localhost:3001-3003`

## Installation

### Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this `sso-extension` folder

### Firefox

1. Go to `about:debugging`
2. Click **This Firefox**
3. Click **Load Temporary Add-on**
4. Select `manifest.json`

## Usage

### Auto-Login (Replay Mode)

1. Login to Primary Identity at `http://localhost:4000/login`
2. Navigate to any legacy app login page
3. Extension auto-fills and submits the form

### First-Time Login (Learning Mode)

1. If no credentials stored, you'll see "First-Time Login" notification
2. Enter credentials manually
3. On success, confirm to save credentials
4. Next time, auto-login will work

## User Notifications

| Event             | Message                                        |
| ----------------- | ---------------------------------------------- |
| Credentials found | "SSO Active - Logging you in automatically"    |
| No credentials    | "First-Time Login - Please log in manually"    |
| Save prompt       | "Save credentials for future automatic login?" |
| Save success      | "Credentials Saved - SSO is now enabled"       |

## API Endpoints Used

| Endpoint                      | Purpose              |
| ----------------------------- | -------------------- |
| `GET /api/session/status`     | Check if logged in   |
| `POST /api/plugin/bootstrap`  | Get token + app list |
| `GET /api/vault/credentials`  | Fetch credentials    |
| `POST /api/vault/credentials` | Save new credentials |
| `PUT /api/vault/password`     | Update password      |

## Security Notes

- **PoC Only**: No encryption, credentials in memory only
- Never persists credentials in browser storage
- Session check runs before every sensitive action
- Logout from Primary Identity immediately disables extension

## Deferred Features

These are planned for future hardening:

- Retry logic
- Rate limiting
- MFA handling
- Role selection
- Keycloak integration
