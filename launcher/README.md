# Legacy App Launcher

A simple navigation UI for accessing the three legacy web applications.

## Description

This is a **navigation-only launcher** with no authentication, sessions, or backend logic. It provides a simple interface to access the three legacy apps.

## Requirements

- Node.js (v14 or higher)
- npm

## Installation

```bash
cd launcher
npm install
```

## Running the Launcher

```bash
npm start
```

Or:

```bash
node app.js
```

The launcher will start at: **http://localhost:3000**

## Available Apps

The launcher provides links to:

| App       | Port | Type             | Link                        |
| --------- | ---- | ---------------- | --------------------------- |
| **App A** | 3001 | Session-based    | http://localhost:3001/login |
| **App B** | 3002 | Session + CSRF   | http://localhost:3002/login |
| **App C** | 3003 | Stateless        | http://localhost:3003/login |
| **App D** | 3004 | Role-based login | http://localhost:3004/login |

## Usage

1. Start all three legacy apps (APP1, APP2, APP3)
2. Start the launcher
3. Open http://localhost:3000 in your browser
4. Click on any app link to launch it in a new tab

## Future SSO Integration

When SSO is introduced:

- This launcher will **remain unchanged**
- SSO will be handled by a browser extension
- Primary identity provider: Keycloak (http://localhost:8080)
- The browser extension will auto-fill credentials on login pages

## Notes

- This is a **dummy navigation UI** for testing purposes
- No authentication or session management
- Bound to 127.0.0.1 for local development only
- All apps must be running for links to work
