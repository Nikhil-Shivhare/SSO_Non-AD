# Vault Service Separation — Enhanced Architecture Plan

## Overview

Separating the credential store from Primary Identity (PID) into a dedicated Vault Service, backed by HA Postgres. This document confirms component boundaries, data ownership, call flows, migration risks, and adds critical enhancements for production readiness.

> **Version**: 2.0 (Enhanced)  
> **Based on**: Original VAULT_ARCHITECTURE.md by Nikhil  
> **Status**: Architecture Planning Complete

---

## Table of Contents

1. [Target Architecture](#target-architecture)
2. [Component Responsibility Matrix](#component-responsibility-matrix)
3. [Data Ownership & Privacy](#data-ownership--privacy)
4. [API Contract (PID ↔ Vault)](#api-contract-pid--vault)
5. [Enhanced Call Flows](#enhanced-call-flows)
6. [Security Enhancements](#security-enhancements)
7. [Observability & Monitoring](#observability--monitoring)
8. [Resilience Patterns](#resilience-patterns)
9. [Migration Strategy](#migration-strategy)
10. [Testing Strategy](#testing-strategy)
11. [Deployment & Operations](#deployment--operations)
12. [Risk Assessment v2](#risk-assessment-v2)
13. [Schema Definitions](#schema-definitions)

---

## Target Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           BROWSER                                        │
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ SSO Extension (unchanged)                                          │  │
│  │  background.js ─── content.js ─── utils.js                        │  │
│  └────────────┬───────────────────────────────────────────────────────┘  │
│               │                                                          │
│               │ External APIs (unchanged, extension-facing)               │
│               │  GET  /api/session/status                                │
│               │  POST /api/plugin/bootstrap                              │
│               │  GET  /api/vault/credentials?appId=X                     │
│               │  POST /api/vault/credentials                             │
│               │  PUT  /api/vault/password                                │
│               │                                                          │
└───────────────┼──────────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ PRIMARY IDENTITY SERVICE (PID)  ─  Port 4000                             │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ AUTHENTICATION LAYER                                                 │  │
│  │  • Session management (HTTP-only cookies)                            │  │
│  │  • Bearer token validation (plugin_tokens table)                   │  │
│  │  • Scope enforcement (vault:read, vault:write)                      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ AUTHORIZATION LAYER                                                  │  │
│  │  • User ↔ App assignment (user_apps table)                         │  │
│  │  • appId → vault_id resolution (apps table)                        │  │
│  │  • Role-based access control (admin, user)                          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ PROXY LAYER (NEW)                                                    │  │
│  │  • Circuit breaker for Vault calls                                   │  │
│  │  • Request/response transformation                                   │  │
│  │  • Error translation (Vault → PID error format)                     │  │
│  │  • Retry logic (exponential backoff)                                │  │
│  │  • Audit logging (PID-side)                                          │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ CACHE LAYER (NEW)                                                    │  │
│  │  • In-memory cache for app metadata (login_schema)                  │  │
│  │  • Optional credential cache (TTL: 30s, configurable)              │  │
│  │  • Cache invalidation on write                                      │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Owns: users, apps, user_apps, plugin_tokens, login_schema               │
│  Does NOT own: vault_credentials (delegated to Vault)                    │
│                                                                           │
└───────────────────────────┬───────────────────────────────────────────────┘
                            │
                            │ Internal API (authenticated service-to-service)
                            │ ┌─────────────────────────────────────────────┐
                            │ │ Security:                                    │
                            │ │  • mTLS certificates (production)           │◄─────┐
                            │ │  • Shared secret token (development)         │      │
                            │ │  • IP whitelist (network isolation)          │      │
                            │ └─────────────────────────────────────────────┘      │
                            │                                                      │
                            │ Endpoints:                                           │
                            │  POST /internal/vault/read           ──► GET        │
                            │  POST /internal/vault/write        ──► UPSERT      │
                            │  POST /internal/vault/update-password ──► PATCH     │
                            │  POST /internal/vault/delete        ──► DELETE      │
                            │  POST /internal/vault/delete-vault ──► BULK DELETE │
                            │  GET  /health                                       │
                            │  GET  /metrics                                     │
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ VAULT SERVICE (new)  ─  Port 5000                                         │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ STATELESS APPLICATION LAYER                                          │  │
│  │  • No sessions, no cookies, no user context                        │  │
│  │  • Horizontally scalable: multiple instances behind LB              │  │
│  │  • Request validation (Zod or Joi)                                  │  │
│  │  • Rate limiting (100 req/min per vault_id)                         │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ ENCRYPTION LAYER (NEW)                                               │  │
│  │  • Field-level encryption (AES-256-GCM)                             │  │
│  │  • Key rotation support (quarterly)                                  │  │
│  │  • Encryption key per vault_id (multi-tenant isolation)             │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Responsibilities:                                                        │
│    - Credential CRUD (identified by vault_id + app_id)                    │
│    - Field-level encryption (AES-256-GCM in production, plaintext PoC)   │
│    - Audit logging (who accessed what, when, from which instance)         │
│    - Rate limiting (prevent abuse)                                         │
│                                                                           │
│  Does NOT do:                                                             │
│    - Authentication (PID handles this)                                    │
│    - Authorization / policy (PID handles this)                            │
│    - Token validation (PID handles this)                                  │
│    - App metadata / login_schema (PID handles this)                       │
│                                                                           │
└───────────────────────────┬───────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ POSTGRES DATABASE (HA)                                                     │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ PRIMARY (read/write)                                                 │  │
│  │  Port: 5433                                                          │  │
│  │  • vault_credentials table                                           │  │
│  │  • audit_log table                                                   │  │
│  │  • Encryption key metadata table (NEW)                              │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│         │                                                                    │
│         │ Streaming Replication                                              │
│         ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │ READ REPLICAS (N)                                                    │  │
│  │  Port: 5434 (and 5435, 5436 for scale)                              │  │
│  │  • All reads routed here (SELECT only)                              │  │
│  │  • Writes rejected (read-only)                                       │  │
│  └─────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│  Table: vault_credentials                                                 │
│    vault_id    TEXT NOT NULL                                               │
│    app_id      TEXT NOT NULL                                               │
│    fields      JSONB NOT NULL       ← Encrypted in production             │
│    created_at  TIMESTAMP                                                  │
│    updated_at  TIMESTAMP                                                  │
│    PRIMARY KEY (vault_id, app_id)                                         │
│                                                                           │
│  Table: audit_log                                                         │
│    id          SERIAL PRIMARY KEY                                         │
│    vault_id    TEXT NOT NULL                                               │
│    app_id      TEXT NOT NULL                                               │
│    action      TEXT NOT NULL         ← 'read', 'write', 'update', 'delete'│
│    instance    TEXT NOT NULL         ← vault instance name                 │
│    latency_ms  INTEGER              ← request processing time              │
│    timestamp   TIMESTAMP DEFAULT NOW()                                    │
│                                                                           │
│  Table: encryption_keys (NEW)                                             │
│    id          SERIAL PRIMARY KEY                                         │
│    vault_id    TEXT NOT NULL                                               │
│    key_version INTEGER NOT NULL                                           │
│    encrypted_key TEXT NOT NULL       ← key encrypted with master key      │
│    created_at  TIMESTAMP DEFAULT NOW()                                    │
│    rotated_at   TIMESTAMP                                                  │
│                                                                           │
└───────────────────────────────────────────────────────────────────────────┘
```

---

## Component Responsibility Matrix

| Responsibility                     | Current Owner | Future Owner    | Change    | Notes                                    |
| ---------------------------------- | ------------- | --------------- | --------- | ---------------------------------------- |
| User authentication (session)      | PID           | PID             | No        | HTTP-only cookies                        |
| Admin panel (user/app CRUD)        | PID           | PID             | No        | Web UI for admins                        |
| App registration + login_schema    | PID           | PID             | No        | login_schema stays in PID                |
| User ↔ App assignment (policy)     | PID           | PID             | No        | user_apps table                          |
| Plugin token issuance + validation | PID           | PID             | No        | ptk_xxx format                           |
| appId → vault_id resolution        | PID (db.js)   | PID             | No        | PID maps appId string to vault_id        |
| Bearer token validation            | PID (app.js)  | PID             | No        | PID validates, Vault trusts              |
| **Service-to-service auth**        | None          | **PID ↔ Vault** | **NEW**   | mTLS or shared secret                    |
| Credential storage (CRUD)          | PID (db.js)   | **Vault**       | **Moved** | Physically separated                     |
| Credential encryption              | None          | **Vault**       | **NEW**   | AES-256-GCM with key rotation            |
| Audit logging (credential access)  | None          | **Vault**       | **NEW**   | Includes latency, instance, action       |
| **Circuit breaker**                | None          | **PID**         | **NEW**   | Prevents cascade failures                |
| **Rate limiting**                  | None          | **Vault**       | **NEW**   | 100 req/min per vault_id                 |
| **Metrics collection**             | None          | **Vault**       | **NEW**   | Prometheus-compatible metrics            |
| **Retry logic**                    | None          | **PID**         | **NEW**   | Exponential backoff (max 3 retries)      |
| **Connection pooling**             | None          | **Vault**       | **NEW**   | pgBouncer or built-in pool               |
| Cascade delete on user removal     | PID (db.js)   | PID → Vault     | Updated   | PID must call Vault API                  |
| Seed data (initial credentials)    | PID (db.js)   | PID → Vault     | Updated   | PID seeds via Vault API during bootstrap |
| Login form detection + filling     | Extension     | Extension       | No        | No change                                |
| Learning mode (credential capture) | Extension     | Extension       | No        | No change                                |
| Password change detection          | Extension     | Extension       | No        | No change                                |

---

## Data Ownership & Privacy

### Privacy Boundary Model

```
┌─────────────────────────────────────────────────────────────────┐
│                         PID (Trust Boundary)                     │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │   users     │  │    apps     │  │    user_apps           │  │
│  │ • username  │  │  appId      │  │  • user ↔ app mapping   │  │
│  │ • vault_id  │  │ • login_schema │ │                         │  │
│  │ • role      │  │ • origin     │  └─────────────────────────┘  │
│  └─────────────┘  └─────────────┘                               │
│         │                                                         │
│         │ Generates opaque vault_id                              │
│         ▼                                                         │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  PID NEVER SHARES:                                           │ │
│  │   • user_id (internal integer)                               │ │
│  │   • username                                                 │ │
│  │   • password_hash                                            │ │
│  │   • role                                                     │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                            │                                      │
│                            │ Calls Vault with vault_id only      │
│                            ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  VAULT (Data Boundary)                       │ │
│  │                                                              │ │
│  │  Vault only knows:                                           │ │
│  │   • vault_id (opaque string)                                 │ │
│  │   • app_id (public app identifier)                           │ │
│  │   • encrypted fields (JSONB)                                  │ │
│  │                                                              │ │
│  │  Vault NEVER knows:                                           │ │
│  │   • Who owns this vault_id                                   │ │
│  │   • What app this app_id represents                          │ │
│  │   • Any user metadata                                         │ │
│  │   • Login schemas or form selectors                          │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### vault_id Generation Strategy

```javascript
// vault_id is an opaque, unguessable string
// Format: vault_{random_32_chars}
// Generated by PID at user creation time

function generateVaultId(userId) {
  const randomPart = crypto.randomBytes(16).toString("hex"); // 32 hex chars
  return `vault_${randomPart}`;
}

// vault_id characteristics:
// - Unpredictable (crypto.randomBytes, not sequential)
// - URL-safe (hex encoded)
// - 40 characters total
// - Unique across all users
// - Never reveals user identity
```

### Data Minimization Principle

| Data               | PID Knows | Vault Knows  | Extension Knows    |
| ------------------ | --------- | ------------ | ------------------ |
| username           | ✅ Yes    | ❌ No        | ✅ Yes (in fields) |
| password           | ❌ No     | ✅ Encrypted | ✅ Yes (in fields) |
| user_id (internal) | ✅ Yes    | ❌ No        | ❌ No              |
| vault_id           | ✅ Yes    | ✅ Yes       | ❌ No              |
| appId (public)     | ✅ Yes    | ✅ Yes       | ✅ Yes             |
| login_schema       | ✅ Yes    | ❌ No        | ✅ Yes (via PID)   |
| user role          | ✅ Yes    | ❌ No        | ❌ No              |

---

## API Contract (PID ↔ Vault)

### Security Requirements

#### Development Environment

```
Authorization: Bearer dev-shared-secret-token
X-Request-ID: <uuid>
X-Source-Service: primary-identity
```

#### Production Environment

```
Authorization: Bearer <mutual-tls-certificate>
X-Request-ID: <uuid>
X-Source-Service: primary-identity
X-Source-IP: <pid-internal-ip>
```

### Endpoint Specifications

#### 1. Health Check

```http
GET /health

Response 200 (OK):
{
  "status": "healthy",
  "service": "vault-service",
  "instance": "vault-7f9b5c4d-xk2p8",
  "version": "2.0.0",
  "uptime_seconds": 86400,
  "database_pool": {
    "total": 20,
    "idle": 15,
    "waiting": 0
  },
  "timestamp": "2024-01-15T10:30:00Z"
}

Response 503 (Unhealthy):
{
  "status": "unhealthy",
  "service": "vault-service",
  "instance": "vault-7f9b5c4d-xk2p8",
  "error": "Database connection failed",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

#### 2. Metrics Endpoint

```http
GET /metrics

Response 200 (OK):
# Prometheus-compatible metrics
vault_requests_total{action="read",status="200"} 1250
vault_requests_total{action="write",status="200"} 340
vault_requests_total{action="update",status="200"} 89
vault_requests_total{action="delete",status="200"} 12
vault_errors_total{type="validation"} 5
vault_errors_total{type="database"} 2
vault_latency_seconds_bucket{action="read",le="0.01"} 1100
vault_latency_seconds_bucket{action="read",le="0.05"} 1245
vault_latency_seconds_bucket{action="read",le="0.1"} 1250
vault_latency_seconds_count{action="read"} 1250
```

#### 3. Read Credentials

```http
POST /internal/vault/read
Authorization: Bearer <service-token>

Request Body:
{
  "vaultId": "vault_a1b2c3d4e5f6",
  "appId": "app_a",
  "requestId": "req-uuid-4x7y"  // Optional, for tracing
}

Response 200 (OK):
{
  "success": true,
  "fields": {
    "username": "testuser",
    "password": "secret123",
    "role": "admin"
  },
  "metadata": {
    "createdAt": "2024-01-01T00:00:00Z",
    "updatedAt": "2024-01-15T10:30:00Z"
  }
}

Response 404 (Not Found):
{
  "success": false,
  "error": "Credentials not found",
  "code": "CREDENTIAL_NOT_FOUND"
}

Response 400 (Validation Error):
{
  "success": false,
  "error": "Invalid vaultId format",
  "code": "VALIDATION_ERROR"
}

Response 429 (Rate Limited):
{
  "success": false,
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT_EXCEEDED",
  "retryAfter": 30
}
```

#### 4. Write Credentials (Upsert)

```http
POST /internal/vault/write
Authorization: Bearer <service-token>

Request Body:
{
  "vaultId": "vault_a1b2c3d4e5f6",
  "appId": "app_a",
  "fields": {
    "username": "testuser",
    "password": "secret123",
    "role": "admin"
  },
  "requestId": "req-uuid-4x7y"
}

Response 200 (OK):
{
  "success": true,
  "message": "Credentials saved",
  "upserted": true  // true = new, false = updated existing
}

Response 400 (Validation Error):
{
  "success": false,
  "error": "Invalid fields: password required",
  "code": "VALIDATION_ERROR"
}
```

#### 5. Update Password (Field Merge)

```http
POST /internal/vault/update-password
Authorization: Bearer <service-token>

Request Body:
{
  "vaultId": "vault_a1b2c3d4e5f6",
  "appId": "app_a",
  "newPassword": "newSecret456"
}

Response 200 (OK):
{
  "success": true,
  "message": "Password updated"
}
```

#### 6. Delete Single Credential

```http
POST /internal/vault/delete
Authorization: Bearer <service-token>

Request Body:
{
  "vaultId": "vault_a1b2c3d4e5f6",
  "appId": "app_a"
}

Response 200 (OK):
{
  "success": true,
  "message": "Credential deleted"
}

Response 404 (Not Found):
{
  "success": false,
  "error": "Credential not found",
  "code": "CREDENTIAL_NOT_FOUND"
}
```

#### 7. Delete All Credentials (Cascade)

```http
POST /internal/vault/delete-vault
Authorization: Bearer <service-token>

Request Body:
{
  "vaultId": "vault_a1b2c3d4e5f6"
}

Response 200 (OK):
{
  "success": true,
  "message": "All credentials deleted",
  "deletedCount": 5  // Number of credentials removed
}
```

### Error Code Reference

| Code                 | HTTP Status | Description                               |
| -------------------- | ----------- | ----------------------------------------- |
| VALIDATION_ERROR     | 400         | Invalid request body or parameters        |
| CREDENTIAL_NOT_FOUND | 404         | No credential exists for (vaultId, appId) |
| RATE_LIMIT_EXCEEDED  | 429         | Too many requests                         |
| INTERNAL_ERROR       | 500         | Unexpected server error                   |
| DATABASE_ERROR       | 503         | Database operation failed                 |
| ENCRYPTION_ERROR     | 500         | Encryption/decryption failed              |
| KEY_ROTATION_ERROR   | 500         | Key rotation operation failed             |

---

## Enhanced Call Flows

### Flow 1: Get Credentials (With Resilience)

```
Extension                        PID (Proxy Layer)                    Vault                   Postgres
   │                              │                                     │                        │
   ├── GET /api/vault/           │                                     │                        │
   │   credentials?appId=app_a ──►│                                     │                        │
   │                              │ 1. Validate bearer token            │                        │
   │                              │    (plugin_tokens table)            │                        │
   │                              │                                     │                        │
   │                              │ 2. Check user_apps                  │                        │
   │                              │    (is user allowed app_a?)          │                        │
   │                              │                                     │                        │
   │                              │ 3. Check circuit breaker            │                        │
   │                              │    (Vault available?)               │                        │
   │                              │    If OPEN: return cached/error     │                        │
   │                              │                                     │                        │
   │                              │ 4. Resolve appId → vault_id          │                        │
   │                              │    (apps table: app_a → "vault_123") │                        │
   │                              │                                     │                        │
   │                              │ 5. Check local cache                │                        │
   │                              │    (TTL: 30s)                       │                        │
   │                              │    If HIT: return cached            │                        │
   │                              │                                     │                        │
   │                              │ ──────────────────────────────────►│                        │
   │                              │ GET /internal/vault/read            │                        │
   │                              │ {vaultId, appId, requestId}         │                        │
   │                              │                                     │                        │
   │                              │                                     ├── SELECT (replica)    │
   │                              │                                     │   FROM vault_creds ───►
   │                              │                                     │                        │
   │                              │                                     ◄── {fields} ──────────┤
   │                              │                                     │                        │
   │                              │ 6. Update cache (if miss)           │                        │
   │                              │                                     │                        │
   │                              │ 7. Log metrics                      │                        │
   │                              │                                     │                        │
   │                              ◄── {fields} ────────────────────────┤                        │
   │                              │                                     │                        │
   │                              │ 8. Attach appId to response         │                        │
   ◄── {appId, fields} ──────────┤                                     │                        │
   │                              │                                     │                        │
```

### Flow 2: Save Credentials (With Encryption)

```
Extension                        PID                              Vault                       Postgres
   │                              │                                │                           │
   ├── POST /api/vault/          │                                │                           │
   │   credentials ──────────────►│                                │                           │
   │   {appId, fields}           │                                │                           │
   │                              ├── 1. Validate bearer token     │                           │
   │                              ├── 2. Check user_apps           │                           │
   │                              ├── 3. Resolve appId → vault_id  │                           │
   │                              │                                │                           │
   │                              ├── POST /internal/vault/write   │                           │
   │                              │   {vaultId, appId, fields} ────►│                           │
   │                              │                                │                           │
   │                              │                                ├── 4. Encrypt fields     │
   │                              │                                │   (AES-256-GCM)          │
   │                              │                                │                           │
   │                              │                                ├── 5. UPSERT              │
   │                              │                                │   INTO vault_creds ──────►
   │                              │                                │                           │
   │                              │                                ├── 6. Audit log           │
   │                              │                                │   INSERT INTO audit_log ─►
   │                              │                                │                           │
   │                              │                                ◄── {success} ────────────┤
   │                              ◄── {success} ────────────────────┤                           │
   ◄── {success} ────────────────┤                                │                           │
```

### Flow 3: Password Update (Atomic)

```
Extension                        PID                              Vault                       Postgres
   │                              │                                │                           │
   ├── PUT /api/vault/            │                                │                           │
   │   password ─────────────────►│                                │                           │
   │   {appId, newPassword}       │                                │                           │
   │                              ├── 1. Validate + authorize      │                           │
   │                              ├── 2. Resolve appId → vault_id │                           │
   │                              │                                │                           │
   │                              ├── POST /internal/vault/        │                           │
   │                              │   update-password ─────────────►│                           │
   │                              │   {vaultId, appId, newPassword} │                           │
   │                              │                                │                           │
   │                              │                                ├── BEGIN TRANSACTION       │
   │                              │                                │                           │
   │                              │                                ├── SELECT FOR UPDATE       │
   │                              │                                │   FROM vault_creds ──────►
   │                              │                                │                           │
   │                              │                                ├── 4. Decrypt existing    │
   │                              │                                │                           │
   │                              │                                ├── 5. Merge password      │
   │                              │                                │   {..., password: new}    │
   │                              │                                │                           │
   │                              │                                ├── 6. Re-encrypt          │
   │                              │                                │                           │
   │                              │                                ├── 7. UPDATE              │
   │                              │                                │   vault_creds ───────────►
   │                              │                                │                           │
   │                              │                                ├── 8. COMMIT              │
   │                              │                                │                           │
   │                              │                                ├── 9. Audit log           │
   │                              │                                │   INSERT INTO audit_log ─►
   │                              │                                │                           │
   │                              │                                ◄── {success} ──────────────┤
   │                              ◄── {success} ────────────────────┤                           │
   ◄── {success} ────────────────┤                                │                           │
```

### Flow 4: Delete User (With Retry)

```
Admin Panel                      PID                              Vault                       Postgres
   │                              │                                │                           │
   ├── POST /admin/users/        │                                │                           │
   │   :id/delete ───────────────►│                                │                           │
   │                              ├── 1. Delete from users table   │                           │
   │                              │   (SQLite)                     │                           │
   │                              │                                │                           │
   │                              ├── 2. ON DELETE CASCADE:        │                           │
   │                              │    - user_apps deleted         │                           │
   │                              │    - plugin_tokens deleted     │                           │
   │                              │                                │                           │
   │                              │ 3. Get vault_id                │                           │
   │                              │                                │                           │
   │                              │ 4. Call Vault with retry       │                           │
   │                              │    (max 3 attempts, exp backoff)│                           │
   │                              │                                │                           │
   │                              │ ──────────────────────────────►│                           │
   │                              │ POST /internal/vault/          │                           │
   │                              │   delete-vault                  │                           │
   │                              │   {vaultId}                     │                           │
   │                              │                                │                           │
   │                              │                                ├── 5. DELETE              │
   │                              │                                │   FROM vault_creds ──────►
   │                              │                                │   WHERE vault_id = X     │
   │                              │                                │                           │
   │                              │                                ├── 6. Audit log           │
   │                              │                                │   INSERT INTO audit_log ─►
   │                              │                                │                           │
   │                              │ 7. If Vault fails:             │                           │
   │                              │    - Log to dead letter queue  │                           │
   │                              │    - Alert admin               │                           │
   │                              │    - Retry later               │                           │
   │                              │                                │                           │
   │                              ◄── {success, deletedCount: N} ──┤                           │
   ◄── redirect ─────────────────┤                                │                           │
```

---

## Security Enhancements

### Field-Level Encryption

```javascript
// Encryption layer (vault-service/src/encryption.js)

const crypto = require("crypto");

class EncryptionService {
  constructor(masterKey) {
    this.masterKey = masterKey; // From environment variable
  }

  /**
   * Encrypt fields JSONB using AES-256-GCM
   * Each vault_id gets its own encryption key
   */
  async encryptFields(vaultId, fields) {
    // Derive key for this vault_id
    const key = await this.deriveKey(vaultId);

    // Generate random IV
    const iv = crypto.randomBytes(16);

    // Create cipher
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    // Encrypt fields as JSON string
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(fields), "utf8"),
      cipher.final(),
    ]);

    // Get auth tag
    const authTag = cipher.getAuthTag();

    // Return IV + authTag + encrypted data
    return {
      iv: iv.toString("base64"),
      authTag: authTag.toString("base64"),
      data: encrypted.toString("base64"),
      version: 1, // For future key rotation
    };
  }

  /**
   * Decrypt fields JSONB
   */
  async decryptFields(vaultId, encryptedPackage) {
    const { iv, authTag, data, version } = encryptedPackage;

    // Handle key version rotation
    const key = await this.getKeyForVersion(vaultId, version);

    // Create decipher
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(authTag, "base64"));

    // Decrypt and parse
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(data, "base64")),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString("utf8"));
  }

  /**
   * Derive encryption key from master key using HKDF
   */
  async deriveKey(vaultId, keyVersion = 1) {
    const info = `vault-encryption:${vaultId}:v${keyVersion}`;
    return crypto.hkdfSync(
      "sha256",
      this.masterKey,
      vaultId, // salt
      info,
      32, // 256 bits
    );
  }
}

module.exports = EncryptionService;
```

### Key Rotation Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                    QUARTERLY KEY ROTATION                        │
│                                                                  │
│  Step 1: Generate new master key version                         │
│          (Keep previous key active for decryption)              │
│                                                                  │
│  Step 2: For each vault_id:                                      │
│          - Derive new encryption key                             │
│          - Re-encrypt all credentials                            │
│          - Update encryption_keys table                          │
│                                                                  │
│  Step 3: Verify all credentials decrypt correctly                │
│                                                                  │
│  Step 4: Archive old key (keep for 90 days for recovery)         │
│                                                                  │
│  Step 5: Remove old key from active use                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Service-to-Service Authentication

```yaml
# Development: Shared Secret Token
VAULT_SERVICE_TOKEN: "dev-shared-secret-change-in-prod"
PID_SERVICE_TOKEN: "dev-shared-secret-change-in-prod"

# Production: mTLS Certificates
# Certificate Requirements:
#   - RSA 4096-bit or ECDSA P-384
#   - Valid for 1 year
#   - DNS names: vault.internal, vault.service
#   - IP SANs: 10.0.1.50, 10.0.1.51
```

### Rate Limiting

```javascript
// vault-service/src/middleware/rateLimiter.js

const rateLimit = require("express-rate-limit");
const Redis = require("ioredis");

const redis = new Redis(process.env.REDIS_URL);

const rateLimiter = rateLimit({
  store: new RedisStore({
    client: redis,
    prefix: "vault:ratelimit:",
  }),
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per window per vault_id
  keyGenerator: (req) => req.body.vaultId || req.ip,
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      error: "Rate limit exceeded",
      code: "RATE_LIMIT_EXCEEDED",
      retryAfter: 60,
    });
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = rateLimiter;
```

---

## Observability & Monitoring

### Metrics Collection

```javascript
// vault-service/src/metrics.js

const promClient = require("prom-client");

// Create a Registry
const register = new promClient.Registry();

// Add default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

// Custom metrics
const requestDuration = new promClient.Histogram({
  name: "vault_request_duration_seconds",
  help: "Duration of Vault requests in seconds",
  labelNames: ["action", "status"],
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
});
register.registerMetric(requestDuration);

const requestsTotal = new promClient.Counter({
  name: "vault_requests_total",
  help: "Total number of Vault requests",
  labelNames: ["action", "status"],
});
register.registerMetric(requestsTotal);

const cacheHitTotal = new promClient.Counter({
  name: "vault_cache_hits_total",
  help: "Total number of cache hits",
  labelNames: ["cache"],
});
register.registerMetric(cacheHitTotal);

const encryptionErrors = new promClient.Counter({
  name: "vault_encryption_errors_total",
  help: "Total number of encryption/decryption errors",
  labelNames: ["operation", "error_type"],
});
register.registerMetric(encryptionErrors);

// Middleware to track metrics
function metricsMiddleware(req, res, next) {
  const start = Date.now();
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;
    const action = req.path.split("/").pop();
    requestDuration.observe({ action, status: res.statusCode }, duration);
    requestsTotal.inc({ action, status: res.statusCode });
  });
  next();
}

module.exports = {
  register,
  metricsMiddleware,
  requestDuration,
  encryptionErrors,
};
```

### Structured Logging

```javascript
// vault-service/src/logger.js

const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  defaultMeta: {
    service: "vault-service",
    instance: process.env.INSTANCE_NAME || "vault",
  },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple(),
      ),
    }),
    new winston.transports.File({
      filename: "logs/vault.log",
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
  ],
});

// Request logging format
logger.requestLog = (req, res, duration) => {
  logger.info("Request completed", {
    method: req.method,
    path: req.path,
    statusCode: res.statusCode,
    duration_ms: duration,
    vaultId: req.body?.vaultId,
    action: req.path.split("/").pop(),
    requestId: req.headers["x-request-id"],
  });
};

module.exports = logger;
```

### Alerting Rules

```yaml
# prometheus/alert-rules.yml

groups:
  - name: vault-alerts
    rules:
      - alert: VaultHighErrorRate
        expr: rate(vault_requests_total{status=~"5.."}[5m]) > 0.1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Vault service high error rate"
          description: "Error rate is {{ $value }} errors/second"

      - alert: VaultHighLatency
        expr: histogram_quantile(0.95, rate(vault_request_duration_seconds_bucket[5m])) > 0.5
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Vault service high latency"
          description: "95th percentile latency is {{ $value }} seconds"

      - alert: VaultDatabaseConnectionPoolExhausted
        expr: vault_database_pool_waiting > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Vault database pool exhausted"
          description: "Requests waiting for database connection"

      - alert: VaultUnreachable
        expr: up{job="vault-service"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Vault service unreachable"
          description: "Vault service is down"
```

---

## Resilience Patterns

### Circuit Breaker Implementation

```javascript
// PID proxy layer - circuit breaker for Vault calls

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.successThreshold = options.successThreshold || 2;
    this.timeout = options.timeout || 30000; // 30 seconds

    this.state = "CLOSED"; // CLOSED, OPEN, HALF_OPEN
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = null;
  }

  async execute(command) {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = "HALF_OPEN";
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    try {
      const result = await command();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  onSuccess() {
    if (this.state === "HALF_OPEN") {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = "CLOSED";
        this.failures = 0;
        this.successes = 0;
      }
    } else {
      this.failures = 0;
    }
  }

  onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.failureThreshold) {
      this.state = "OPEN";
    }
  }
}

// Usage in PID vaultClient
const breaker = new CircuitBreaker({ failureThreshold: 3, timeout: 60000 });

async function readWithBreaker(vaultId, appId) {
  return breaker.execute(async () => {
    return await vaultRequest("/internal/vault/read", { vaultId, appId });
  });
}
```

### Retry Logic

```javascript
// PID proxy layer - exponential backoff retry

async function retryWithBackoff(fn, maxRetries = 3) {
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry on 4xx errors (client errors)
      if (error.status >= 400 && error.status < 500) {
        throw error;
      }

      // Exponential backoff: 100ms, 500ms, 2500ms
      const delay = Math.pow(5, attempt) * 20;
      console.log(
        `[RETRY] Attempt ${attempt + 1} failed, retrying in ${delay}ms`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
```

### Dead Letter Queue for Failed Operations

```javascript
// PID proxy layer - dead letter queue for failed Vault operations

const { Queue: RedisQueue } = require("bullmq");
const redis = new Redis(process.env.REDIS_URL);

const deadLetterQueue = new RedisQueue("vault-failed-operations", { redis });

// When Vault call fails after all retries
async function queueForRetry(operation) {
  await deadLetterQueue.add({
    operation,
    queuedAt: new Date().toISOString(),
    retryCount: 0,
  });
}

// Retry worker (runs separately)
async function processDeadLetterQueue() {
  const job = await deadLetterQueue.getNextJob();
  if (!job) return;

  const { operation } = job.data;

  try {
    await executeVaultOperation(operation);
    await job.moveToCompleted();
  } catch (error) {
    if (job.data.retryCount < 5) {
      // Re-queue with incremented retry count
      await job.update({
        ...job.data,
        retryCount: job.data.retryCount + 1,
        lastError: error.message,
      });
      await job.moveToDelayed(Date.now() + 5 * 60 * 1000); // 5 minutes
    } else {
      // Give up, move to dead
      await job.moveToFailed({ error: error.message });
      // Alert operations team
      await alertTeam(operation, error);
    }
  }
}
```

---

## Migration Strategy

### Phase 1: Dual Write (Week 1-2)

```javascript
// In PID db.js - modify existing vault functions to write to both

async function saveVaultCredentialsDualWrite(userId, appId, fields) {
    // Write to existing SQLite vault_credentials table
    run('INSERT OR REPLACE INTO vault_credentials ...', [...]);

    // ALSO write to new Vault Service
    const vaultId = getVaultId(userId);
    const app = getAppByAppId(appId);

    try {
        await vaultClient.write(vaultId, app.appId, fields);
        console.log('[MIGRATION] Dual write succeeded');
    } catch (error) {
        console.error('[MIGRATION] Dual write failed, data only in SQLite:', error.message);
        // Alert: manual intervention needed
    }
}
```

### Phase 2: Read from Both, Write to New (Week 3-4)

```javascript
async function getVaultCredentialsMigrated(userId, appId) {
  // Try Vault first (new system)
  const vaultId = getVaultId(userId);
  const vaultResult = await vaultClient.read(vaultId, appId);

  if (vaultResult.success) {
    return { source: "vault", fields: vaultResult.fields };
  }

  // Fallback to SQLite (old system)
  const sqliteResult = queryOne(
    "SELECT * FROM vault_credentials WHERE user_id = ? AND app_id = ?",
    [userId, app.id],
  );

  if (sqliteResult) {
    return { source: "sqlite", fields: sqliteResult.fields };
  }

  return null;
}
```

### Phase 3: Read from New Only (Week 5-6)

```javascript
async function getVaultCredentialsFinal(userId, appId) {
  const vaultId = getVaultId(userId);
  const vaultResult = await vaultClient.read(vaultId, appId);

  if (!vaultResult.success) {
    throw new Error("Credential not found in Vault");
  }

  return vaultResult.fields;
}
```

### Phase 4: Data Migration Script (Week 7)

```bash
#!/bin/bash
# migrate-vault-data.sh

# 1. Export all credentials from SQLite
echo "Exporting credentials from SQLite..."
sqlite3 primary-identity/database.sqlite \
    "SELECT user_id, app_id, fields FROM vault_credentials" \
    > /tmp/credentials.csv

# 2. Transform and load to Vault
echo "Loading credentials to Vault..."
while IFS=',' read -r userId appId fields; do
    vaultId="vault_$userId"
    curl -X POST "http://localhost:5000/internal/vault/write" \
        -H "Content-Type: application/json" \
        -d "{\"vaultId\":\"$vaultId\",\"appId\":\"$appId\",\"fields\":$fields}"
done < /tmp/credentials.csv

# 3. Verify migration
echo "Verifying migration..."
# Compare counts between SQLite and Vault
```

### Migration Checklist

| Step | Task                              | Status | Rollback Plan             |
| ---- | --------------------------------- | ------ | ------------------------- |
| 1    | Deploy Vault Service (read-only)  | ☐      | Disable Vault Service     |
| 2    | Enable dual-write in PID          | ☐      | Disable dual-write flag   |
| 3    | Migrate 10% of users              | ☐      | Revert migrated users     |
| 4    | Monitor error rates (target: <1%) | ☐      | Pause migration           |
| 5    | Migrate 50% of users              | ☐      | Revert migrated users     |
| 6    | Monitor error rates (target: <1%) | ☐      | Pause migration           |
| 7    | Migrate 100% of users             | ☐      | Keep both systems running |
| 8    | Disable SQLite vault reads        | ☐      | Re-enable SQLite reads    |
| 9    | Run validation script             | ☐      | Restore from backup       |
| 10   | Decommission SQLite vault table   | ☐      | Keep table but unused     |

---

## Testing Strategy

### Unit Tests

```javascript
// vault-service/test/encryption.test.js

describe("EncryptionService", () => {
  let encryption;

  beforeEach(() => {
    encryption = new EncryptionService("test-master-key");
  });

  it("should encrypt and decrypt fields correctly", async () => {
    const fields = { username: "test", password: "secret", role: "admin" };
    const encrypted = await encryption.encryptFields("vault_123", fields);
    const decrypted = await encryption.decryptFields("vault_123", encrypted);

    expect(decrypted).toEqual(fields);
  });

  it("should produce different ciphertext for same plaintext", async () => {
    const fields = { password: "secret" };
    const encrypted1 = await encryption.encryptFields("vault_123", fields);
    const encrypted2 = await encryption.encryptFields("vault_123", fields);

    expect(encrypted1.data).not.toEqual(encrypted2.data); // IV ensures uniqueness
  });

  it("should throw error for invalid vault_id", async () => {
    await expect(
      encryption.decryptFields("unknown_vault", {
        iv: "...",
        authTag: "...",
        data: "...",
      }),
    ).rejects.toThrow("Key not found");
  });
});
```

### Integration Tests

```javascript
// vault-service/test/integration.test.js

describe("Vault Service Integration", () => {
  let vaultClient;

  beforeAll(async () => {
    vaultClient = new VaultClient("http://localhost:5000");
  });

  describe("Credential CRUD", () => {
    it("should create and retrieve credentials", async () => {
      const vaultId = "vault_test_" + Date.now();
      const appId = "app_test";
      const fields = { username: "testuser", password: "testpass" };

      // Write
      const writeResult = await vaultClient.write(vaultId, appId, fields);
      expect(writeResult.success).toBe(true);

      // Read
      const readResult = await vaultClient.read(vaultId, appId);
      expect(readResult.success).toBe(true);
      expect(readResult.fields).toEqual(fields);

      // Cleanup
      await vaultClient.delete(vaultId, appId);
    });

    it("should update password field only", async () => {
      const vaultId = "vault_test_" + Date.now();
      const appId = "app_test";
      const initialFields = {
        username: "user",
        password: "old",
        role: "admin",
      };
      const newPassword = "newpassword";

      await vaultClient.write(vaultId, appId, initialFields);
      await vaultClient.updatePassword(vaultId, appId, newPassword);

      const result = await vaultClient.read(vaultId, appId);
      expect(result.fields.password).toBe(newPassword);
      expect(result.fields.role).toBe("admin"); // Other fields preserved

      await vaultClient.delete(vaultId, appId);
    });

    it("should handle rate limiting", async () => {
      // Make 101 requests in 1 minute
      const vaultId = "vault_test_rate";
      for (let i = 0; i < 101; i++) {
        const result = await vaultClient.read(vaultId, "app_test");
        if (i < 100) expect(result.success).toBe(true);
        else expect(result.status).toBe(429);
      }
    });
  });
});
```

### End-to-End Tests

```javascript
// integration/e2e.test.js

describe("Full Credential Flow", () => {
  it("should support complete credential lifecycle", async () => {
    // 1. User logs into PID
    const loginResponse = await request(PID_URL)
      .post("/login")
      .send({ username: "testuser", password: "TestPass123!" });
    expect(loginResponse.status).toBe(302);

    const cookie = loginResponse.headers["set-cookie"];

    // 2. Extension bootstraps
    const bootstrapResponse = await request(PID_URL)
      .post("/api/plugin/bootstrap")
      .set("Cookie", cookie);
    expect(bootstrapResponse.body.pluginToken).toBeDefined();

    const { pluginToken, userId } = bootstrapResponse.body;

    // 3. Extension gets credentials using token
    const credentialsResponse = await request(PID_URL)
      .get("/api/vault/credentials?appId=app_a")
      .set("Authorization", `Bearer ${pluginToken}`);
    expect(credentialsResponse.body.fields).toBeDefined();

    // 4. Extension updates password (simulated password change)
    const updateResponse = await request(PID_URL)
      .put("/api/vault/password")
      .set("Authorization", `Bearer ${pluginToken}`)
      .send({ appId: "app_a", newPassword: "ChangedPass123!" });
    expect(updateResponse.body.success).toBe(true);

    // 5. Verify password was updated in Vault
    const vaultCredentials = await vaultClient.read(`vault_${userId}`, "app_a");
    expect(vaultCredentials.fields.password).toBe("ChangedPass123!");
  });
});
```

### Performance Tests

```javascript
// k6/load-test.js

import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const errorRate = new Rate("errors");
const latency = new Trend("latency");

export let options = {
  stages: [
    { duration: "30s", target: 10 }, // Warm up
    { duration: "1m", target: 50 }, // Ramp up
    { duration: "2m", target: 100 }, // Peak load
    { duration: "1m", target: 50 }, // Ramp down
    { duration: "30s", target: 0 }, // Cool down
  ],
  thresholds: {
    http_req_duration: ["p(95)<500"], // 95th percentile < 500ms
    errors: ["rate<0.01"], // Error rate < 1%
  },
};

export default function () {
  const vaultId = `vault_load_test_${Math.floor(Math.random() * 1000)}`;
  const appId = "app_a";

  // Read operation
  const readRes = http.post(
    "http://localhost:5000/internal/vault/read",
    JSON.stringify({ vaultId, appId }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
    },
  );

  latency.add(readRes.timings.duration);
  errorRate.add(readRes.status !== 200);

  check(readRes, {
    "read status is 200": (r) => r.status === 200 || r.status === 404,
  });

  sleep(0.1);
}
```

---

## Deployment & Operations

### Docker Compose (Development)

```yaml
# vault-service/docker-compose.yml

version: "3.8"

services:
  vault:
    build: .
    ports:
      - "5000:5000"
    environment:
      - PORT=5000
      - INSTANCE_NAME=vault-dev
      - DATABASE_URL=postgresql://vault_user:vault_pass@postgres:5432/vault_db
      - VAULT_SERVICE_TOKEN=${VAULT_SERVICE_TOKEN:-dev-shared-secret}
      - MASTER_KEY=${MASTER_KEY:-dev-master-key-change-in-prod}
      - LOG_LEVEL=debug
    depends_on:
      postgres:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 10s
      timeout: 5s
      retries: 5

  postgres:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=vault_user
      - POSTGRES_PASSWORD=vault_pass
      - POSTGRES_DB=vault_db
    ports:
      - "5433:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vault_user -d vault_db"]
      interval: 5s
      timeout: 5s
      retries: 5

  # Optional: Read replica for development
  postgres-replica:
    image: postgres:15-alpine
    environment:
      - POSTGRES_USER=vault_user
      - POSTGRES_PASSWORD=vault_pass
      - POSTGRES_DB=vault_db
    ports:
      - "5434:5432"
    command: >
      postgres
      -c hot_standby=on
      -c hot_standby_feedback=on
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - postgres_replica_data:/var/lib/postgresql/data

volumes:
  postgres_data:
  postgres_replica_data:
```

### Kubernetes (Production)

```yaml
# k8s/vault-service.yaml

apiVersion: apps/v1
kind: Deployment
metadata:
  name: vault-service
  namespace: sso-platform
spec:
  replicas: 3
  selector:
    matchLabels:
      app: vault-service
  template:
    metadata:
      labels:
        app: vault-service
    spec:
      containers:
        - name: vault
          image: vault-service:2.0.0
          ports:
            - containerPort: 5000
          env:
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: vault-secrets
                  key: database-url
            - name: MASTER_KEY
              valueFrom:
                secretKeyRef:
                  name: vault-secrets
                  key: master-key
            - name: VAULT_SERVICE_TOKEN
              valueFrom:
                secretKeyRef:
                  name: vault-secrets
                  key: service-token
          resources:
            requests:
              memory: "256Mi"
              cpu: "250m"
            limits:
              memory: "512Mi"
              cpu: "500m"
          livenessProbe:
            httpGet:
              path: /health
              port: 5000
            initialDelaySeconds: 10
            periodSeconds: 30
          readinessProbe:
            httpGet:
              path: /health
              port: 5000
            initialDelaySeconds: 5
            periodSeconds: 10

---
apiVersion: v1
kind: Service
metadata:
  name: vault-service
  namespace: sso-platform
spec:
  selector:
    app: vault-service
  ports:
    - port: 80
      targetPort: 5000
  type: ClusterIP

---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: vault-service-hpa
  namespace: sso-platform
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: vault-service
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
```

### Disaster Recovery

#### Backup Strategy

```bash
#!/bin/bash
# backup-vault.sh

# Daily full backup at 2 AM
BACKUP_DIR="/backups/vault"
DATE=$(date +%Y%m%d_%H%M%S)

# 1. PostgreSQL backup (pg_dump with custom format for point-in-time recovery)
pg_dump -Fc -U vault_user -d vault_db > "$BACKUP_DIR/vault_$DATE.dump"

# 2. Compress and encrypt
gpg --symmetric --cipher-algo AES256 "$BACKUP_DIR/vault_$DATE.dump"
rm "$BACKUP_DIR/vault_$DATE.dump"

# 3. Upload to S3
aws s3 cp "$BACKUP_DIR/vault_$DATE.dump.gpg" s3://sso-backups/vault/

# 4. Keep only last 30 daily backups
aws s3 ls s3://sso-backups/vault/ | head -n -30 | awk '{print $4}' | \
    xargs -I {} aws s3 rm s3://sso-backups/vault/{}

# 5. Verify backup integrity
pg_restore --list "$BACKUP_DIR/vault_$DATE.dump.gpg" | head -20
```

#### Recovery Procedure

```bash
#!/bin/bash
# restore-vault.sh

BACKUP_FILE=$1

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: restore-vault.sh <backup-file>"
    exit 1
fi

# 1. Stop Vault service
kubectl scale deployment vault-service --replicas=0 -n sso-platform

# 2. Drop and recreate database
psql -U postgres -c "DROP DATABASE IF EXISTS vault_db;"
psql -U postgres -c "CREATE DATABASE vault_db WITH OWNER vault_user;"

# 3. Restore from backup
pg_restore -U vault_user -d vault_db "$BACKUP_FILE"

# 4. Verify
psql -U vault_user -d vault_db -c "SELECT COUNT(*) FROM vault_credentials;"
psql -U vault_user -d vault_db -c "SELECT COUNT(*) FROM audit_log;"

# 5. Restart Vault service
kubectl scale deployment vault-service --replicas=3 -n sso-platform
```

#### Recovery Time Objectives

| Scenario                 | RTO (Recovery Time) | RPO (Recovery Point) | Procedure              |
| ------------------------ | ------------------- | -------------------- | ---------------------- |
| Single replica failure   | < 1 minute (auto)   | 0                    | K8s auto-restart       |
| Primary database failure | < 5 minutes         | < 1 minute           | Promote replica        |
| Region outage            | < 1 hour            | < 1 hour             | Restore from backup    |
| Data corruption          | < 4 hours           | < 24 hours           | Point-in-time recovery |

---

## Risk Assessment v2

| Risk                           | Severity | Likelihood | Mitigation                                                                                       |
| ------------------------------ | -------- | ---------- | ------------------------------------------------------------------------------------------------ |
| **Vault unavailability**       | HIGH     | MEDIUM     | Health checks, circuit breaker, graceful degradation, extension shows "service unavailable"      |
| **Network latency**            | MEDIUM   | MEDIUM     | Vault on same network segment, connection pooling, short TTL cache in PID                        |
| **Data migration**             | HIGH     | MEDIUM     | Dual-write phase, parallel read validation, rollback script, gradual cutover                     |
| **Cascade delete timing**      | MEDIUM   | LOW        | Synchronous Vault call with transaction rollback, dead letter queue for retries                  |
| **Seed data ordering**         | LOW      | LOW        | Retry logic in seed function, health check before seeding                                        |
| **Password update atomicity**  | MEDIUM   | LOW        | Single Vault transaction, no read-modify-write                                                   |
| **Encryption key compromise**  | CRITICAL | LOW        | Quarterly key rotation, separate master key storage, audit logging                               |
| **Vault token leakage**        | HIGH     | LOW        | Service-to-service mTLS, IP whitelist, short-lived tokens, token rotation                        |
| **Rate limit bypass**          | MEDIUM   | LOW        | Multiple rate limit tiers (per vault_id, global), behavior analysis                              |
| **Data breach**                | CRITICAL | LOW        | Field-level encryption, principle of least privilege, audit logging, intrusion detection         |
| **Cross-tenant access**        | CRITICAL | VERY LOW   | vault_id as privacy boundary, encrypted per vault_id, no tenant ID in Vault                      |
| **Connection pool exhaustion** | HIGH     | MEDIUM     | pgBouncer, proper pool sizing, monitoring, circuit breaker                                       |
| **Schema migration failure**   | HIGH     | LOW        | Backward-compatible migrations, test migrations, rollback script, zero-downtime deployment       |
| **Extension API breakage**     | HIGH     | VERY LOW   | PID proxy maintains external API contract, versioned API responses, backward compatibility layer |

---

## Schema Definitions

### PID Database (SQLite)

```sql
-- Users table
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    vault_id      TEXT UNIQUE NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Applications registry
CREATE TABLE IF NOT EXISTS apps (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    appId       TEXT UNIQUE NOT NULL,
    origin      TEXT NOT NULL,
    login_schema TEXT DEFAULT NULL,  -- JSON: { username: {...}, password: {...}, role: {...} }
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- User ↔ App mapping (policy)
CREATE TABLE IF NOT EXISTS user_apps (
    user_id     INTEGER NOT NULL,
    app_id      INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_id, app_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);

-- Plugin tokens (extension authentication)
CREATE TABLE IF NOT EXISTS plugin_tokens (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT UNIQUE NOT NULL,
    user_id     INTEGER NOT NULL,
    scopes      TEXT NOT NULL,  -- JSON array: ["vault:read", "vault:write"]
    expires_at  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_vault_id ON users(vault_id);
CREATE INDEX IF NOT EXISTS idx_apps_appid ON apps(appId);
CREATE INDEX IF NOT EXISTS idx_user_apps_user ON user_apps(user_id);
CREATE INDEX IF NOT EXISTS idx_plugin_tokens_token ON plugin_tokens(token);
CREATE INDEX IF NOT EXISTS idx_plugin_tokens_expires ON plugin_tokens(expires_at);
```

### Vault Database (PostgreSQL)

```sql
-- Credential storage (one row per vault_id + app_id)
CREATE TABLE IF NOT EXISTS vault_credentials (
    vault_id    TEXT NOT NULL,
    app_id      TEXT NOT NULL,
    fields      JSONB NOT NULL DEFAULT '{}',  -- Encrypted in production
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, app_id)
);

-- Audit log (append-only)
CREATE TABLE IF NOT EXISTS audit_log (
    id          SERIAL PRIMARY KEY,
    vault_id   TEXT NOT NULL,
    app_id     TEXT NOT NULL,
    action     TEXT NOT NULL CHECK(action IN ('read', 'write', 'update', 'delete', 'delete-vault')),
    instance   TEXT NOT NULL,  -- Vault instance name
    latency_ms INTEGER,         -- Request processing time
    request_id TEXT,           -- Correlation ID
    error_msg  TEXT,           -- NULL on success
    timestamp  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Encryption keys (for key rotation)
CREATE TABLE IF NOT EXISTS encryption_keys (
    id            SERIAL PRIMARY KEY,
    vault_id     TEXT NOT NULL,
    key_version  INTEGER NOT NULL,
    encrypted_key TEXT NOT NULL,  -- Key encrypted with master key
    master_key_id TEXT NOT NULL,  -- Which master key version
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    rotated_at    TIMESTAMP,
    UNIQUE (vault_id, key_version)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_audit_log_vault ON audit_log(vault_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_enc_keys_vault ON encryption_keys(vault_id);

-- Partial index for recent audit logs (last 30 days)
CREATE INDEX IF NOT EXISTS idx_audit_log_recent ON audit_log(timestamp DESC)
    WHERE timestamp > NOW() - INTERVAL '30 days';
```

---

## Summary

### Key Enhancements in v2

1. **Security Hardening**
   - Field-level encryption with key rotation
   - Service-to-service authentication (mTLS)
   - Rate limiting per vault_id
   - Audit logging with latency tracking

2. **Resilience Patterns**
   - Circuit breaker in PID proxy layer
   - Exponential backoff retry logic
   - Dead letter queue for failed operations
   - Graceful degradation strategies

3. **Observability**
   - Prometheus-compatible metrics
   - Structured JSON logging
   - Alerting rules for production
   - Request tracing (X-Request-ID)

4. **Operations Readiness**
   - Docker Compose for development
   - Kubernetes manifests for production
   - Backup and recovery procedures
   - Disaster recovery runbooks

5. **Migration Strategy**
   - Phased approach (dual write → read both → cutover)
   - Rollback plan at each phase
   - Validation scripts

6. **Testing Coverage**
   - Unit tests for encryption
   - Integration tests for CRUD
   - End-to-end tests for full flow
   - Load testing with k6

### Compatibility Matrix

| Component | Current Version | Target Version  | Breaking Changes       |
| --------- | --------------- | --------------- | ---------------------- |
| Extension | 1.x             | 1.x (unchanged) | None                   |
| PID       | 1.x             | 2.0             | External API unchanged |
| Vault     | N/A             | 2.0             | New component          |
| Postgres  | N/A             | 15+             | New dependency         |

---

## Next Steps

1. ☐ Review and approve enhanced architecture
2. ☐ Create implementation tasks in project management
3. ☐ Set up CI/CD pipeline for Vault Service
4. ☐ Implement encryption layer (Phase 1)
5. ☐ Implement Vault CRUD endpoints with validation
6. ☐ Add circuit breaker and retry logic to PID
7. ☐ Set up monitoring and alerting
8. ☐ Create migration scripts
9. ☐ Run load tests
10. ☐ Execute phased migration

---

_Document generated: 2024-01-15_  
_Version: 2.0_  
_Author: Architecture Team_
