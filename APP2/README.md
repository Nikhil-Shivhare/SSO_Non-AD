# App-B: Session + CSRF Legacy Web Application

A minimal session-based legacy web app with CSRF protection for SSO testing.

## Description

This app simulates a traditional legacy application with enhanced security:

- Session-based authentication (30-minute timeout)
- **CSRF protection** on all state-changing operations
- SQLite for user storage
- bcrypt for password hashing
- Standard HTML form inputs compatible with browser extension auto-fill

## Requirements

- Node.js (v14 or higher)
- npm

## Installation

```bash
cd APP2
npm install
```

## Running the App

```bash
npm start
```

Or:

```bash
node app.js
```

The app will start at: **http://localhost:3002**

## Endpoints

| Method | Path               | Description                                 |
| ------ | ------------------ | ------------------------------------------- |
| GET    | `/login`           | Login page with CSRF token                  |
| POST   | `/login`           | Validate CSRF + credentials, create session |
| GET    | `/register`        | Registration form with CSRF token           |
| POST   | `/register`        | Validate CSRF + create user                 |
| GET    | `/dashboard`       | Dashboard (requires active session)         |
| GET    | `/change-password` | Password change form with CSRF token        |
| POST   | `/change-password` | Validate CSRF + update password             |
| GET    | `/logout`          | Destroy session and logout                  |

## Form Field Names

For SSO browser extension compatibility:

- **Login/Register:**
  - `username` - Username field
  - `password` - Password field
  - `_csrf` - Hidden CSRF token (auto-generated)

- **Change Password:**
  - `current_password` - Current password
  - `new_password` - New password
  - `_csrf` - Hidden CSRF token (auto-generated)

## CSRF Protection

**What is CSRF?**
Cross-Site Request Forgery (CSRF) is an attack where malicious websites trick authenticated users into performing unwanted actions.

**How this app protects against CSRF:**

1. Server generates unique token for each session
2. Token is embedded in all forms as hidden field `_csrf`
3. Server validates token on POST requests
4. Requests without valid token are rejected with 403 error

**Forms protected by CSRF:**

- Login form
- Registration form
- Change password form

## Behavior

- After successful login, a session is created (30-minute expiration)
- All state-changing operations require valid CSRF token
- Refreshing the dashboard page keeps you logged in (session persists)
- Protected routes redirect to `/login` if no active session
- Invalid CSRF tokens result in error page

## SSO Integration

This app is designed to work with a browser extension that:

1. Validates user session against Keycloak (localhost:8080)
2. Auto-fills credentials on the login form
3. Includes CSRF token in form submission
4. Submits the form via standard POST request

## Notes

- This is a **dummy legacy application** for testing purposes
- No OAuth, OIDC, JWT, or external authentication
- Bound to 127.0.0.1 for local development only
- Session stored in memory (will be lost on server restart)
- CSRF tokens stored in session (not cookies)
