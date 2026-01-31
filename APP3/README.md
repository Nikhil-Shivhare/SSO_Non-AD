# App-C: Stateless Legacy Web Application

A minimal stateless legacy web app for SSO testing with browser extension credential auto-fill.

## Description

This app simulates a very old legacy application that:

- Requires login on every page refresh (no sessions, cookies, or localStorage)
- Uses SQLite for user storage
- Uses bcrypt for password hashing
- Has standard HTML form inputs compatible with browser extension auto-fill

## Requirements

- Node.js (v14 or higher)
- npm

## Installation

```bash
cd APP3
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

The app will start at: **http://localhost:3003**

## Endpoints

| Method | Path               | Description                                  |
| ------ | ------------------ | -------------------------------------------- |
| GET    | `/login`           | Login page with registration link            |
| POST   | `/login`           | Validate credentials, returns dashboard HTML |
| GET    | `/register`        | Registration form                            |
| POST   | `/register`        | Create new user account                      |
| GET    | `/dashboard`       | Redirects to `/login` (stateless)            |
| POST   | `/change-password` | Change user password                         |

## Form Field Names

For SSO browser extension compatibility:
 
- **Login/Register:**
  - `username` - Username field
  - `password` - Password field

- **Change Password:**
  - `username` - Username (hidden field)
  - `current_password` - Current password
  - `new_password` - New password

## Behavior

- After successful login, the dashboard is returned directly in the response
- Refreshing the dashboard page redirects back to login (no session persistence)
- Direct access to `/dashboard` always redirects to `/login`
- Password changes require current password verification

## SSO Integration

This app is designed to work with a browser extension that:

1. Validates user session against Keycloak (localhost:8080)
2. Auto-fills credentials on the login form
3. Submits the form via standard POST request

## Notes

- This is a **dummy legacy application** for testing purposes
- No OAuth, OIDC, JWT, or external authentication
- Bound to 127.0.0.1 for local development only
