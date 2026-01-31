# App-D: Role-Based Login Legacy App

A minimal legacy web app that **requires role selection during login**, breaking naive SSO credential replay.

## Description

This app demonstrates a critical **SSO edge case**: login requires THREE pieces of information:

1. Username
2. Password
3. **Role selection**

### Why This Breaks Naive SSO

Browser extensions that only replay username/password will **FAIL** because:

- Login form has a **required role selector** (`<select name="role">`)
- Authentication validates that selected role matches user's DB role
- Wrong role selection = login rejected

This tests whether SSO extensions can handle **non-standard form fields** beyond username/password.

## Requirements

- Node.js (v14 or higher)
- npm

## Installation

```bash
cd APP4
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

The app will start at: **http://localhost:3004**

## Seed Users

The database is automatically seeded with four users:

| Username | Password    | Role     | Dashboard           |
| -------- | ----------- | -------- | ------------------- |
| admin1   | AdminPass!  | admin    | /dashboard/admin    |
| hr1      | HrPass!     | hr       | /dashboard/hr       |
| intern1  | InternPass! | intern   | /dashboard/intern   |
| ext1     | ExtPass!    | external | /dashboard/external |

## Login Process

1. **Visit**: http://localhost:3004/login
2. **Fill**:
   - Username (e.g., `admin1`)
   - Password (e.g., `AdminPass!`)
   - **Role** (e.g., `admin`) ← **CRITICAL**
3. **Submit**: Login succeeds only if role matches

## Authentication Logic

```
POST /login:
  1. Validate username exists
  2. Validate password matches hash
  3. Validate selected role matches user.role in DB ← NEW!
  4. If role mismatch → REJECT with error
  5. If all valid → Create session, redirect to /dashboard/{role}
```

## Endpoints

| Method | Path                  | Description                                 |
| ------ | --------------------- | ------------------------------------------- |
| GET    | `/login`              | Login form with role selector               |
| POST   | `/login`              | Validate credentials + role                 |
| GET    | `/dashboard/admin`    | Admin dashboard (requires admin role)       |
| GET    | `/dashboard/hr`       | HR dashboard (requires hr role)             |
| GET    | `/dashboard/intern`   | Intern dashboard (requires intern role)     |
| GET    | `/dashboard/external` | External dashboard (requires external role) |
| GET    | `/change-password`    | Password change form                        |
| POST   | `/change-password`    | Update password                             |
| GET    | `/logout`             | Destroy session                             |

## Testing Naive SSO Failure

### Scenario 1: Wrong Role Selected

```
Username: admin1
Password: AdminPass!
Role: hr  ← WRONG!
```

**Result**: ❌ Login fails with "Invalid role selection"

### Scenario 2: Correct Role Selected

```
Username: admin1
Password: AdminPass!
Role: admin  ← CORRECT!
```

**Result**: ✅ Login succeeds, redirects to /dashboard/admin

## SSO Extension Challenge

For SSO to work, extensions must:

1. **Detect** the role selector field
2. **Determine** the correct role for the user
3. **Select** the role in the dropdown
4. **Submit** the form with all three values

Simply replaying stored username/password **will not work**.

## Why This Matters

Many legacy applications have:

- **Department/division selectors**
- **Environment choosers** (production, staging, etc.)
- **Tenant/organization pickers**
- **Access level dropdowns**

SSO solutions must handle these **context-dependent fields**, not just credentials.

## Form Field Names

- `username` - Username input
- `password` - Password input
- `role` - Role selector (dropdown)

## Session Behavior

- After successful login, session contains:
  - `userId`
  - `username`
  - `role` ← **Stored for dashboard access control**
  - `displayName`
- Session expires after 30 minutes
- Role-specific dashboards check session role
- Accessing wrong dashboard shows 403 error

## Notes

- This is a **dummy legacy application** for SSO testing
- No OAuth, OIDC, JWT, or external authentication
- Bound to 127.0.0.1 for local development only
- Session stored in memory (lost on server restart)
