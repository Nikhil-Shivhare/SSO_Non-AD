# App-A: Session-Based Legacy Web Application

A minimal session-based legacy web app for SSO testing with browser extension credential auto-fill.

## Description

This app simulates a traditional legacy application with:

- Session-based authentication (30-minute timeout)
- SQLite for user storage
- bcrypt for password hashing
- Standard HTML form inputs compatible with browser extension auto-fill

## Requirements

- Node.js (v14 or higher)
- npm

## Installation

```bash
cd APP1
npm install
```

## Running the App

```bash
```

Or:

```bash
node app.js
```

The app will start at: **http://localhost:3001**

## Endpoints

| Method | Path               | Description                             |
| ------ | ------------------ | --------------------------------------- |
| GET    | `/login`           | Login page with registration link       |
| POST   | `/login`           | Validate credentials and create session |
| GET    | `/register`        | Registration form                       |
| POST   | `/register`        | Create new user account                 |
| GET    | `/dashboard`       | Dashboard (requires active session)     |
| GET    | `/change-password` | Password change form (requires session) |
| POST   | `/change-password` | Update user password                    |
| GET    | `/logout`          | Destroy session and logout              |

## Form Field Names

For SSO browser extension compatibility:

- **Login/Register:**
  - `username` - Username field
  - `password` - Password field

- **Change Password:**
  - `current_password` - Current password
  - `new_password` - New password

## Behavior

- After successful login, a session is created (30-minute expiration)
- Refreshing the dashboard page keeps you logged in (session persists)
- Protected routes redirect to `/login` if no active session
- Logout destroys the session and redirects to login

## SSO Integration

This app is designed to work with a browser extension that:

1. Validates user session against Keycloak (localhost:8080)
2. Auto-fills credentials on the login form
3. Submits the form via standard POST request

## Notes

- This is a **dummy legacy application** for testing purposes
- No OAuth, OIDC, JWT, or external authentication
- Bound to 127.0.0.1 for local development only
- Session stored in memory (will be lost on server restart)
