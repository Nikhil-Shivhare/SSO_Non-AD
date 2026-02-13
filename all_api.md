# System API Documentation

This document provides a comprehensive inventory of **all** API calls and HTTP routes across the entire system, including the Browser Extension, Primary Identity (PID), Vault Service, Target Apps, and Launcher.

## 1. Browser Extension ↔ Primary Identity (PID)

These APIs allow the extension to authenticate the user and retrieve/save credentials.

| Method | Endpoint                 | Description                           | Payload / Query                        | Response                                     |
| :----- | :----------------------- | :------------------------------------ | :------------------------------------- | :------------------------------------------- |
| `GET`  | `/api/session/status`    | Check if user is logged into PID      | Cookie: `PID_SESSION`                  | `{ authenticated: true/false, userId: ... }` |
| `POST` | `/api/plugin/bootstrap`  | Initial handshake to get plugin token | Cookie: `PID_SESSION`                  | `{ pluginToken: "...", apps: [...] }`        |
| `POST` | `/api/token/introspect`  | Validate if a token is active         | `{ pluginToken: "..." }`               | `{ active: true/false, ... }`                |
| `GET`  | `/api/vault/credentials` | Fetch credentials for an app          | `?appId=app_a` (Header: Bearer Token)  | `{ appId: "...", fields: { ... } }`          |
| `POST` | `/api/vault/credentials` | Save new credentials                  | `{ appId: "...", fields: { ... } }`    | `{ success: true }`                          |
| `PUT`  | `/api/vault/password`    | Update password only                  | `{ appId: "...", newPassword: "..." }` | `{ success: true }`                          |

## 2. PID ↔ Vault Service (Internal)

These are internal calls made _by PID_ to the isolated Vault Service. **Not publicly accessible.**

| Method | Endpoint                          | Description                             | Payload                                                | Response                |
| :----- | :-------------------------------- | :-------------------------------------- | :----------------------------------------------------- | :---------------------- |
| `GET`  | `/health`                         | Service health check                    | None                                                   | `{ status: "ok", ... }` |
| `POST` | `/internal/vault/read`            | Retrieve raw credentials from DB        | `{ vaultId: "...", appId: "..." }`                     | `{ fields: { ... } }`   |
| `POST` | `/internal/vault/write`           | Save/Upsert credentials to DB           | `{ vaultId: "...", appId: "...", fields: { ... } }`    | `{ success: true }`     |
| `POST` | `/internal/vault/update-password` | Merge new password into existing record | `{ vaultId: "...", appId: "...", newPassword: "..." }` | `{ success: true }`     |
| `POST` | `/internal/vault/delete`          | Delete a single credential              | `{ vaultId: "...", appId: "..." }`                     | `{ success: true }`     |
| `POST` | `/internal/vault/delete-vault`    | Delete ALL data for a user (Cascade)    | `{ vaultId: "..." }`                                   | `{ success: true }`     |

## 3. Browser ↔ PID (User Interface)

Standard web routes for user interaction (HTML pages).

| Method | Endpoint     | Description                              |
| :----- | :----------- | :--------------------------------------- |
| `GET`  | `/login`     | Serves the Login Page                    |
| `POST` | `/login`     | Processes Login Form (Username/Password) |
| `GET`  | `/logout`    | Destroys session and redirects to login  |
| `GET`  | `/dashboard` | User Dashboard (lists assigned apps)     |

## 4. Browser ↔ PID (Admin UI)

Admin-only routes for user and app management.

| Method | Endpoint                  | Description                               |
| :----- | :------------------------ | :---------------------------------------- |
| `GET`  | `/admin`                  | Admin Panel Dashboard (Users list, Forms) |
| `POST` | `/admin/users`            | Create new user                           |
| `POST` | `/admin/users/:id/delete` | Delete user (Triggers Vault deletion)     |
| `POST` | `/admin/assign-app`       | Assign app to user                        |
| `POST` | `/admin/remove-app`       | Remove app from user                      |

## 5. Browser ↔ Target Apps (App 1-4)

Routes exposed by the target applications for the extension to interact with.

| App            | Method | Endpoint                        | Description               |
| :------------- | :----- | :------------------------------ | :------------------------ |
| **Common**     | `GET`  | `/login`                        | Login Page                |
|                | `POST` | `/login`                        | Process Login Form        |
|                | `GET`  | `/logout`                       | Logout                    |
|                | `GET`  | `/dashboard`                    | App Dashboard (Protected) |
|                | `GET`  | `/register`                     | Registration Page         |
|                | `POST` | `/register`                     | Process Registration      |
| **App 4 Only** | `GET`  | `/dashboard/admin`, `/hr`, etc. | Role-based Dashboards     |

## 6. Browser ↔ Launcher

Simple navigation UI to launch the apps.

| Method | Endpoint | Description                       |
| :----- | :------- | :-------------------------------- |
| `GET`  | `/`      | Launcher Homepage (Links to Apps) |
