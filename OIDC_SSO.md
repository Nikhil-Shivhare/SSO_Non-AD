# OIDC SSO MVP Implementation Plan

## 1. Objective

Add a third SSO category to the existing Non-AD SSO project without disturbing the current credential replay flow or the new SAML federated flow.

Current supported categories:

```text
1. Credential Replay SSO
   For unmodified legacy apps that only expose username/password forms.
   Implemented using Chrome extension + PID + Vault.

2. SAML Federated SSO
   For apps that can integrate with a standards-based Identity Provider.
   Implemented using PID as a SAML Identity Provider and App E as a SAML Service Provider.
```

New category to add:

```text
3. OIDC Federated SSO
   For modern apps (SPAs, mobile apps, microservices) that prefer JSON/JWT over XML.
   Implemented using PID as an OpenID Connect Provider and App F as an OIDC Client.
```

Final demo statement:

```text
This platform supports three SSO scenarios:
1. Browser extension credential replay SSO for unmodified legacy apps.
2. SAML federated SSO for applications that support standards-based federation.
3. OIDC federated SSO for modern applications preferring JSON/JWT-based authentication.
```

---

## 2. Non-Negotiable Constraint

The current working project must not be affected.

Do not change:

- Existing browser extension behavior.
- Existing `/api/vault/*` APIs.
- Existing PID login/dashboard/admin behavior (except minor additions).
- Existing Apps A-D.
- Existing Vault Service behavior.
- Existing extension manifest matches.
- Existing SAML routes (`/saml/*`) and `saml_idp.py`.
- Existing SAML App E.

Add OIDC as a side-by-side feature:

```text
PID existing routes       -> unchanged
PID new OIDC routes       -> /.well-known/openid-configuration, /authorize, /token, /userinfo
New dummy OIDC app        -> OIDC App (App F), port 3006
New documentation         -> OIDC_SSO.md (this file)
New database table        -> oidc_clients (separate from saml_service_providers)
```

---

## 3. MVP Scope

The MVP should implement only the minimum useful OIDC flow:

- PID acts as OpenID Connect Provider (OP).
- One dummy app (App F) acts as OIDC Client / Relying Party (RP).
- Authorization Code flow (the most common OIDC flow).
- User logs in through existing PID login.
- PID issues ID Token (JWT) and Access Token.
- App F validates ID Token signature and claims.
- App F creates its own local session.
- User accesses App F dashboard without another password prompt if already logged into PID.

Out of scope for MVP:

- PKCE (Proof Key for Code Exchange)
- Refresh tokens
- UserInfo endpoint enrichment beyond basic claims
- Dynamic client registration
- Admin UI for OIDC clients (CLI/direct DB seed for MVP)
- JWT token revocation / introspection endpoint
- Token encryption
- Production key management (HMAC secret stays simple for MVP)
- Multi-tenant OIDC configuration
- Scopes beyond `openid profile email`
- Consent screen

---

## 4. Target Demo Flow

### First-Time Flow

```text
1. User opens http://localhost:3006/login
2. App F redirects browser to:
   http://localhost:4000/authorize?response_type=code&scope=openid+profile+email&client_id=app_f&redirect_uri=http://localhost:3006/callback
3. PID receives the authorize request.
4. PID checks whether user has PID_SESSION.
5. User is not logged in, so PID stores pending OIDC request in session.
6. PID redirects user to /login?oidc_resume=1.
7. User logs in using existing PID credentials.
8. PID detects pending OIDC request after login.
9. PID continues OIDC flow.
10. PID redirects browser back to App F /callback with ?code=AUTH_CODE.
11. App F receives the code.
12. App F makes a direct server-side POST to PID /token with the code.
13. PID validates the code and returns:
    {
      "access_token": "...",
      "id_token": "<JWT>",
      "token_type": "Bearer",
      "expires_in": 3600
    }
14. App F verifies the ID Token signature using PID's public key/JWKS.
15. App F validates ID Token claims (iss, aud, exp, nonce if used).
16. App F creates its own local session.
17. User lands on App F dashboard.
```

### SSO Flow After PID Login

```text
1. User logs into PID once.
2. User opens http://localhost:3006/login.
3. App F redirects to PID /authorize.
4. PID sees existing PID_SESSION.
5. PID immediately redirects back to App F /callback with ?code=AUTH_CODE.
6. App F exchanges code for tokens.
7. App F verifies ID Token and opens dashboard.
8. User is not asked for password again.
```

---

## 5. Architecture

```text
Browser
  |
  | 1. Opens App F
  v
App F (OIDC Client / RP), port 3006
  |
  | 2. Redirects to PID /authorize
  v
PID (OpenID Connect Provider / OP), port 4000
  |
  | 3. Uses existing PID session/login (single sign-on)
  |
  | 4. Issues Authorization Code -> redirects to App F /callback
  v
App F /callback
  |
  | 5. Server-side POST to PID /token (code exchange)
  v
PID /token
  |
  | 6. Returns ID Token (JWT) + Access Token
  v
App F
  |
  | 7. Verifies ID Token, creates local session
  v
App F Dashboard
```

Important boundary:

```text
OIDC SSO does not use Vault.
OIDC SSO does not use the browser extension.
OIDC SSO uses PID session as the central login session.
OIDC SSO uses JWT tokens instead of XML assertions.
```

---

## 6. Suggested Files

Add new files:

```text
PID/oidc_provider.py
PID/certs/dev-oidc.key        # or reuse dev-idp.key/config
App F/app.js
App F/package.json
App F/README.md
```

Modify existing files carefully:

```text
PID/database.py
PID/app.py
PID/requirements.txt
start-all.sh (only after manual success)
stop-all.sh (only after manual success)
launcher/app.js (only after manual success)
README.md (only after manual success)
```

Avoid modifying:

```text
sso-extension/*
vault-service/*
SAML App (App E)/*
PID/saml_idp.py
Session based App (App A)/*
Session + CSRF App (App B)/*
Stateless App (App C)/*
Role-based login App (App D)/*
```

---

## 7. Technology Choice

### PID, OpenID Connect Provider

Use Python libraries appropriate for building a minimal OIDC provider:

```text
pyjwt  -> JWT creation and validation
cryptography -> HMAC signing (for MVP) or RSA keypair
```

Do NOT use heavy OIDC provider frameworks for the MVP.

Reason:

- A full OIDC provider library (like `oidcop`) is overkill for a single-client MVP.
- PID already handles sessions and users. We only need to add OIDC protocol endpoints.
- Building a small OIDC layer on top of existing PID is faster and keeps control.

Install:

```bash
pip install pyjwt cryptography
```

For MVP, HMAC (HS256) signing is acceptable if:

- The shared secret is not hardcoded in production.
- App F verifies signature using the same secret.
- The secret moves to an environment variable later.
- RSA (RS256) can replace HS256 without changing the OIDC discovery document.

### App F, OIDC Client

Use Node.js Express, matching Apps A-E.

Use:

```text
openid-client -> OIDC client library (handles discovery, code exchange, token validation)
express-session -> App F local session after OIDC login
```

Install:

```bash
# MVP: pin v4 — v5 is a full ES module rewrite with a completely different API
npm install openid-client@4 express-session
```

Minimum App F OIDC configuration:

> **MVP note:** For HS256, do **not** set `jwks_uri`. `openid-client` cannot load a symmetric
> secret from a public JWKS URL and will throw "no applicable keys" at token validation.
> Instead, set `id_token_signed_response_alg: "HS256"` on the Client — the library will
> then use `client_secret` directly as the HMAC verify key.

```javascript
const { Issuer, generators } = require("openid-client"); // v4 API — requires openid-client@4

// For HS256 MVP: omit jwks_uri — App F verifies tokens using client_secret as the HMAC key
const issuer = new Issuer({
  issuer: "http://localhost:4000",
  authorization_endpoint: "http://localhost:4000/authorize",
  token_endpoint: "http://localhost:4000/token",
  userinfo_endpoint: "http://localhost:4000/userinfo",
  // jwks_uri intentionally omitted for HS256 MVP
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["HS256"],
  scopes_supported: ["openid", "profile", "email"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
});

const client = new issuer.Client({
  client_id: "app_f",
  client_secret: "app_f_secret_development_only", // used as HS256 HMAC verify key
  redirect_uris: ["http://localhost:3006/callback"],
  response_types: ["code"],
  id_token_signed_response_alg: "HS256", // tells openid-client to expect HS256 tokens
});
```

`openid-client` v4 handles authorization URL generation (including `state` and `nonce`),
code exchange, and ID Token validation automatically. The library generates a `nonce` by
default — PID must store and echo it back in the ID Token (see §11 DB schema).

---

## 8. OIDC Concepts Used In MVP

| OIDC Concept                | Meaning In This Project                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| Provider (OP)               | PID                                                                            |
| Client / Relying Party (RP) | App F                                                                          |
| Authorization Endpoint      | `http://localhost:4000/authorize`                                              |
| Token Endpoint              | `http://localhost:4000/token`                                                  |
| UserInfo Endpoint           | `http://localhost:4000/userinfo`                                               |
| JWKS Endpoint               | `http://localhost:4000/.well-known/jwks.json`                                  |
| Discovery Document          | `http://localhost:4000/.well-known/openid-configuration`                       |
| ID Token                    | JWT issued by PID identifying the user                                         |
| Access Token                | Token App F can use to call UserInfo (not strictly required in MVP but issued) |
| Authorization Code          | Short-lived code exchanged for tokens                                          |
| Client ID                   | `app_f` (identifies App F to PID)                                              |
| Client Secret               | Shared secret between PID and App F                                            |
| Redirect URI                | `http://localhost:3006/callback` (where PID sends the code)                    |
| Scope                       | `openid profile email`                                                         |
| Subject (`sub`)             | Unique user identifier (username or user ID)                                   |

---

## 9. PID OIDC Routes

Add routes on PID.

### `GET /.well-known/openid-configuration`

Returns OIDC discovery JSON. Allows clients like App F to auto-discover PID endpoints without hardcoding URLs.

Contains:

```json
{
  "issuer": "http://localhost:4000",
  "authorization_endpoint": "http://localhost:4000/authorize",
  "token_endpoint": "http://localhost:4000/token",
  "userinfo_endpoint": "http://localhost:4000/userinfo",
  "jwks_uri": "http://localhost:4000/.well-known/jwks.json",
  "scopes_supported": ["openid", "profile", "email"],
  "response_types_supported": ["code"],
  "subject_types_supported": ["public"],
  "id_token_signing_alg_values_supported": ["HS256"],
  "token_endpoint_auth_methods_supported": ["client_secret_post"]
}
```

### `GET /.well-known/jwks.json`

Returns public key(s) for verifying ID Token signatures.

For HS256 (MVP):

> **CRITICAL:** Do **not** put the HMAC secret into the JWKS endpoint.
> An `oct` (symmetric) JWK in a publicly accessible URL defeats the purpose of signing —
> anyone who reads it can forge tokens. Additionally, `openid-client` refuses to load
> symmetric keys from a remote JWKS URL for exactly this reason.
>
> For HS256 MVP, return an empty keys array. App F verifies tokens using `client_secret`
> directly (via `id_token_signed_response_alg: "HS256"` — no JWKS fetch needed).

```json
{ "keys": [] }
```

For RS256 (post-MVP):

```json
{
  "keys": [
    {
      "kty": "RSA",
      "kid": "pid-oidc-dev-key",
      "alg": "RS256",
      "use": "sig",
      "n": "<base64url-modulus>",
      "e": "AQAB"
    }
  ]
}
```

RS256 upgrade path: generate an RSA keypair, expose the public key above, set
`id_token_signing_alg_values_supported: ["RS256"]` in the discovery document, and
update `id_token_signed_response_alg` in App F's client config to `"RS256"`.

### `GET /authorize`

OIDC Authorization Endpoint.

Responsibilities:

- Validate `client_id` against registered OIDC clients.
- Validate `redirect_uri` exactly matches registered value (prevent open redirect).
- Validate `response_type=code`.
- Validate `scope` includes `openid`.
- Check that `client_id` is registered and enabled.
- If user is not logged in:
  - Store pending OIDC state in session (client_id, redirect_uri, scope, state/nonce if used).
  - Redirect to `/login?oidc_resume=1`.
- If user is logged in:
  - Generate authorization code.
  - Store code in server-side store with expiry.
  - Redirect to `redirect_uri?code=AUTH_CODE&state=...`.

Required query parameters (MVP minimum):

| Parameter       | Required    | Description                                                       |
| --------------- | ----------- | ----------------------------------------------------------------- |
| `response_type` | Yes         | Must be `code`                                                    |
| `client_id`     | Yes         | Must match a registered OIDC client                               |
| `redirect_uri`  | Yes         | Must exactly match registered URI                                 |
| `scope`         | Yes         | Must include `openid`                                             |
| `state`         | Recommended | Opaque value returned unchanged                                   |
| `nonce`         | Recommended | Random value; must be stored with the code and echoed in ID Token |

### `POST /token`

OIDC Token Endpoint.

Responsibilities:

- Accept `grant_type=authorization_code`.
- Accept `code`, `client_id`, `client_secret`, `redirect_uri`.
- Validate code exists in store and is not expired.
- Validate client_id + client_secret match registration.
- Validate redirect_uri matches.
- Generate ID Token (JWT) with claims.
- Generate Access Token (random string or JWT).
- Return JSON response:

```json
{
  "access_token": "eyJ...",
  "id_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

ID Token claims (minimum):

| Claim | Value                   | Notes      |
| ----- | ----------------------- | ---------- |
| `iss` | `http://localhost:4000` | Issuer     |
| `sub` | username or user ID     | Subject    |
| `aud` | client_id (app_f)       | Audience   |
| `exp` | current time + TTL      | Expiration |
| `iat` | current time            | Issued at  |
| `iss` | `http://localhost:4000` | Issuer     |

With `scope=profile email`:

| Claim   | Value                  | Notes                           |
| ------- | ---------------------- | ------------------------------- |
| `name`  | username               | Profile scope                   |
| `email` | username@example.local | Email scope (synthetic for MVP) |

### `GET /userinfo`

OIDC UserInfo Endpoint.

Responsibilities:

- Require valid `Authorization: Bearer <access_token>` header.
- Validate access token (MVP: decode as JWT using the same HS256 secret — no separate table needed).
- Extract `sub` claim from the decoded JWT to identify the user.
- Return JSON with user claims:

```json
{
  "sub": "testuser",
  "name": "testuser",
  "email": "testuser@example.local",
  "preferred_username": "testuser"
}
```

> **MVP access token design:** PID issues the access token as a short-lived JWT signed
> with the same HS256 secret. The `/userinfo` endpoint decodes it directly — no
> `oidc_access_tokens` DB table is needed for MVP. Claims: `sub` (username), `scope`,
> `exp` (short TTL, e.g., 3600 s), `iss`. Reject if expired or signature invalid.

For MVP, `openid-client` may call `/userinfo` automatically during token exchange.
If it does, the Bearer token it sends is the `access_token` from the `/token` response.

---

## 10. Required Small Change In PID Login

After successful existing PID login, add a minimal resume hook (slightly different shape from SAML):

```text
if request.session has pending_oidc_request:
    redirect to /authorize?resume=1 (or /oidc/resume)
else:
    redirect to /dashboard
```

Important:

- Normal PID login must still go to `/dashboard`.
- Extension bootstrap must remain unchanged.
- This hook should only run when pending OIDC state exists.
- Preserve pending OIDC state if login hardening clears or recreates session data.

Implementation rule:

> **CRITICAL:** The existing login handler already captures `pending_saml_request`.
> Do **not** replace that logic — extend it. Both SAML and OIDC state must be
> captured before `session.clear()` and restored after.

```python
# Capture BOTH pending states BEFORE session.clear()
# (Starlette signed-cookie sessions: data is lost after clear())
pending_saml = request.session.get("pending_saml_request")   # existing SAML hook
pending_oidc = request.session.get("pending_oidc_request")   # new OIDC hook

request.session.clear()
request.session["userId"]   = user["id"]
request.session["username"] = user["username"]
request.session["role"]     = user["role"]

# OIDC takes priority if both are somehow pending (edge case in testing)
if pending_oidc:
    request.session["pending_oidc_request"] = pending_oidc
    print(f"[OIDC] Post-login: pending OIDC request found, resuming for {user['username']}")
    return RedirectResponse(url="/oidc/resume", status_code=302)

if pending_saml:
    request.session["pending_saml_request"] = pending_saml
    print(f"[SAML] Post-login: pending SAML request found, resuming for {user['username']}")
    return RedirectResponse(url="/saml/resume", status_code=302)

return RedirectResponse(url="/dashboard", status_code=302)
```

Clear `pending_oidc_request` only after `/oidc/resume` successfully generates the authorization code.

### Optional Resume Route

Add:

```text
GET /oidc/resume
```

Purpose:

- Read pending OIDC request from PID session.
- Validate client_id, redirect_uri, scope.
- Generate authorization code.
- Store code with TTL.
- Clear pending state.
- Redirect to `redirect_uri?code=AUTH_CODE&state=...`.

This makes login integration cleaner.

---

## 11. PID Database Changes

Add one new table:

```sql
CREATE TABLE IF NOT EXISTS oidc_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT UNIQUE NOT NULL,
    client_secret TEXT NOT NULL,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oidc_authorization_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    client_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    redirect_uri TEXT NOT NULL,
    scope TEXT NOT NULL,
    nonce TEXT,                    -- echo back in id_token nonce claim; NULL if client did not send one
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

> **MVP access token note:** No `oidc_access_tokens` table is needed. PID issues the
> access token as a JWT (HS256, same secret, short TTL). The `/userinfo` endpoint
> decodes it inline — no DB lookup required. If token revocation is needed later,
> add an `oidc_access_tokens` table at that point.

> **Nonce flow:** `/authorize` receives `nonce` → store in `oidc_authorization_codes.nonce`
> → `/token` reads it → includes `nonce` claim in ID Token → `openid-client` validates it
> matches what it originally sent. Missing nonce in the ID Token causes a `nonce mismatch`
> error in `openid-client` even for MVP.

Seed one OIDC client:

```text
client_id: app_f
client_secret: app_f_secret_development_only
name: App F OIDC Demo
redirect_uris: http://localhost:3006/callback
enabled: 1
```

Do not reuse the existing `apps` table or `saml_service_providers` table.

Reason:

- OIDC uses a different config model (client credentials, redirect URIs, scopes).
- Keeping a separate table prevents accidental mix-ups between SAML SPs and OIDC clients.

---

## 12. ID Token Contents

For MVP, PID should issue:

```text
iss:   http://localhost:4000
sub:   testuser (or user ID)
aud:   app_f
exp:   3600 seconds from now
iat:   now
email: testuser@example.local (synthetic)
name:  testuser
```

Email can be synthetic for MVP because current PID users do not have email.

For MVP, HS256 (HMAC-SHA256) is acceptable as a starting point. The secret should be loaded from environment variables. RS256 (RSA-SHA256) can replace HS256 later by:

- Adding an RSA keypair on PID.
- Updating JWKS to expose the RSA public key.
- Updating `id_token_signing_alg_values_supported` in the discovery document.
- No changes needed on App F if `openid-client` is configured to accept both.

---

## 13. OIDC App F Routes

### `GET /`

If logged in:

```text
redirect /dashboard
```

If not logged in:

```text
redirect /login
```

### `GET /login`

Shows a page with one button:

```text
Login with PID OIDC SSO
```

For MVP, button can simply link to `/oidc/login`.

### `GET /oidc/login`

Uses `openid-client` to build the authorization URL and redirects to PID.

```text
http://localhost:4000/authorize?response_type=code&scope=openid+profile+email&client_id=app_f&redirect_uri=http://localhost:3006/callback&state=...
```

### `GET /callback`

Receives the authorization code.

Responsibilities:

- Receive `code` and `state` from PID.
- Make a server-side POST to PID `/token` with `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`.
- Parse token response.
- Verify ID Token claims.
- If valid:
  - Create App F session (store username, email, issuer, login time).
  - Redirect `/dashboard`.
- If invalid:
  - Return 401 with a short diagnostic message.

### `GET /dashboard`

Requires App F session.

Display:

```text
Logged in using OIDC SSO
Username: testuser
Email: testuser@example.local
Issuer: http://localhost:4000
Login Method: OIDC Authorization Code
```

### `GET /logout`

Destroy only App F session.

MVP does not need RP-initiated logout.

---

## 14. Configuration Values

Use environment variables where reasonable:

```text
# PID OIDC Provider
PID_OIDC_ISSUER=http://localhost:4000
PID_OIDC_SECRET=development_secret_change_in_production_HS256
PID_OIDC_TOKEN_TTL_SECONDS=3600
PID_OIDC_CODE_TTL_SECONDS=300
```

For App F:

```text
APP_F_PORT=3006
APP_F_REDIRECT_URI=http://localhost:3006/callback
PID_ISSUER_URL=http://localhost:4000
OIDC_CLIENT_ID=app_f
OIDC_CLIENT_SECRET=app_f_secret_development_only
```

---

## 15. Implementation Phases

### Phase 0: Safety Setup

Tasks:

- Confirm current services still run.
- Do not touch extension, Apps A-D, SAML routes, or Vault.

Validation:

```text
Existing PID login still works.
Existing extension SSO still works.
Existing Vault health endpoint still works.
SAML App E still works.
```

### Phase 1: Add App F Skeleton

Tasks:

- Create `OIDC App (App F)/package.json`.
- Create `OIDC App (App F)/app.js`.
- Add basic Express server on port 3006.
- Add `/`, `/login`, `/dashboard`, `/logout`.

Validation:

```text
http://localhost:3006 opens.
Dashboard is protected.
Logout clears local App F session.
```

### Phase 2: Add OIDC Database Tables

Tasks:

- Add `oidc_clients` table to `init_database()` in `database.py`.
- Add `oidc_authorization_codes` table to `init_database()` in `database.py`.
- Add `seed_oidc_client_if_missing()` function in `database.py` (mirrors existing `seed_saml_sp_if_missing()`).
- Call `db.seed_oidc_client_if_missing()` inside `startup()` in `app.py` — place it next to the existing `db.seed_saml_sp_if_missing()` call.
- Seed one client: `client_id=app_f`, `client_secret=app_f_secret_development_only`, `redirect_uris=http://localhost:3006/callback`.

Validation:

```text
SQLite tables oidc_clients and oidc_authorization_codes exist.
App F client row exists in oidc_clients.
PID starts clean and app_f row is present without manual seeding.
Existing PID tables (users, apps, saml_service_providers, etc.) still exist unchanged.
```

### Phase 3: Add PID OIDC Discovery and JWKS Endpoints

Tasks:

- Add `PID/oidc_provider.py`.
- Add `/.well-known/openid-configuration`.
- Add `/.well-known/jwks.json`.
- Load signing secret or keypair.

Validation:

```text
http://localhost:4000/.well-known/openid-configuration returns valid JSON.
http://localhost:4000/.well-known/jwks.json returns key(s).
Discovery document contains correct PID issuer and endpoints.
```

### Phase 4: Add PID Authorization Endpoint

Tasks:

- Add `/authorize`.
- Validate `client_id`, `redirect_uri`, `response_type`, `scope`.
- If user is not logged in, store pending OIDC state and redirect to `/login`.
- If user is logged in, generate authorization code, store it, and redirect to `redirect_uri?code=...&state=...`.

Validation:

```text
Unauthenticated user is redirected to PID login.
Authenticated user gets a code and is redirected back to App F.
Malformed authorize requests return proper error responses.
Unknown client_id is rejected.
Redirect URI mismatch is rejected (open redirect prevention).
```

### Phase 5: Add OIDC Resume After Login

Tasks:

- Add minimal post-login hook in PID.
- Add `/oidc/resume` or equivalent.
- After user logs in, resume pending OIDC request.
- Clear pending OIDC data after use.

Validation:

```text
Opening App F while logged out sends user to PID login.
After login, user returns to App F automatically.
Normal PID login still redirects to /dashboard.
```

### Phase 6: Add PID Token Endpoint

Tasks:

- Add `/token`.
- Accept `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`.
- Validate code exists and is not expired.
- Validate client credentials.
- Generate ID Token (JWT) and Access Token.
- Return JSON token response.

Validation:

```text
App F can exchange code for tokens.
Expired authorization code is rejected.
Wrong client_secret is rejected.
ID Token contains expected claims (iss, sub, aud, exp, iat).
```

### Phase 7: Add PID UserInfo Endpoint

Tasks:

- Add `/userinfo`.
- Require Bearer access token.
- Return JSON user claims.

Validation:

```text
Valid access token returns user info.
Missing or invalid token returns 401.
Response includes sub, name, email.
```

### Phase 8: Verify ID Token and Finish App F

Tasks:

- Add `/callback` in App F.
- Exchange code for tokens using `openid-client`.
- Verify ID Token signature against PID JWKS.
- Validate claims (`iss`, `aud`, `exp`).
- Create App F session.
- Redirect `/dashboard`.

Validation:

```text
Full OIDC flow works: App F -> PID -> App F dashboard.
Tampered ID Token is rejected.
Expired ID Token is rejected.
Wrong audience is rejected.
```

### Phase 9: Demo And Regression Testing

Test OIDC:

```text
Case 1: App F -> PID login -> App F dashboard.
Case 2: PID already logged in -> App F dashboard without password.
Case 3: App F logout -> PID still logged in -> App F login works without password.
Case 4: Invalid authorization code rejected.
Case 5: Expired authorization code rejected.
Case 6: Wrong client_secret rejected.
Case 7: Tampered ID Token rejected.
```

Test old system:

```text
PID login still works.
Admin page still works.
Extension bootstrap still works.
Vault credential APIs still work.
Apps A-D still work.
SAML App E still works.
```

---

## 16. Security Checklist

MVP must include:

- Authorization code bound to a single client_id and redirect_uri.
- Short authorization code TTL (5 minutes).
- Authorization code single-use (marked `used=1` after exchange).
- Client authentication at token endpoint (client_secret).
- ID Token signed with validated algorithm (HS256 for MVP, RS256 recommended before production).
- ID Token expiry (1 hour or less).
- Issuer validation.
- Audience validation (client_id).
- Redirect URI exact match (no wildcards).
- Open redirect prevention.
- `state` parameter passed through unchanged (if used).
- No credential or token logging.
- JWKS endpoint exposes only public verification material.

Can be added after MVP:

- PKCE (Proof Key for Code Exchange)
- Refresh tokens with rotation
- Token revocation endpoint
- RS256 with proper key rotation
- Consent screen
- Per-client scope restrictions
- Admin UI for OIDC clients
- Token introspection endpoint
- Pushed Authorization Requests (PAR)

---

## 17. Common Future Problems

### JWT Secret Leakage

Development HMAC secret might accidentally be treated as production.

Mitigation:

- Store secret in environment variable (`PID_OIDC_SECRET`).
- Document it as local-only.
- Rotate by changing the environment variable and invalidating all existing tokens.

### Open Redirect via redirect_uri

Malicious request could ask PID to redirect to attacker site.

Mitigation:

- Always match `redirect_uri` exactly against the registered URI (no prefix matching).
- Reject requests with mismatched URIs.

### Authorization Code Replay

Code could be captured and reused.

Mitigation:

- Single-use: mark code as `used=1` immediately on successful exchange.
- Short TTL: codes expire in 5 minutes.
- Client authentication required at token endpoint.

### Clock Skew

Tokens may be rejected if machine clocks differ.

Mitigation:

- Use short token TTL (1 hour).
- Accept small clock skew in JWT `exp` validation (e.g., 30 seconds) during local MVP testing.

### Same-App OIDC / SAML Session Conflict

If App F and App E run on different ports, they have different session cookies. This is correct behavior — each app manages its own local session.

Mitigation:

- PID manages the central login session (PID_SESSION).
- App F and App E each have their own independent local sessions.
- Logging out of PID does NOT need to log out of App F or App E in MVP.

---

## 18. Minimal Demo Script

### Demo 1: Existing Credential Replay SSO

```text
1. Login to PID.
2. Open App A or App D.
3. Extension fills and submits login form.
4. Explain: this works for apps that cannot be modified.
```

### Demo 2: Existing SAML Federated SSO

```text
1. Open http://localhost:3005/login.
2. Click "Login with PID SAML SSO".
3. Browser goes to PID login.
4. Login as testuser.
5. Browser returns to App E dashboard.
6. Explain: SAML uses XML assertions for enterprise apps.
```

### Demo 3: New OIDC Federated SSO

```text
1. Logout from PID and App F.
2. Open http://localhost:3006/login.
3. Click "Login with PID OIDC SSO".
4. Browser goes to PID login.
5. Login as testuser.
6. Browser returns to App F callback -> App F exchanges code for tokens.
7. User lands on App F dashboard.
8. Logout only from App F.
9. Open App F login again.
10. No PID password prompt appears because PID session exists.
11. App F dashboard opens again.
```

Interview explanation:

```text
This platform supports three SSO scenarios:
1. Credential replay for legacy apps via browser extension.
2. SAML federated SSO using XML assertions for enterprise apps.
3. OIDC federated SSO using JWT tokens for modern apps, SPAs, and mobile.
```

---

## 19. Acceptance Criteria

OIDC MVP is complete when:

- PID exposes valid OIDC discovery document.
- PID exposes JWKS endpoint.
- App F can initiate OIDC authorization.
- PID acts as OpenID Connect Provider.
- PID issues valid authorization codes.
- PID exchanges codes for signed ID Tokens (JWT).
- App F validates ID Token and creates local session.
- User can login to App F through PID.
- User can access App F without re-login when PID session already exists.
- Invalid or tampered ID Tokens are rejected.
- Expired authorization codes are rejected.
- Existing credential replay SSO remains unaffected.
- Existing SAML SSO remains unaffected.

---

## 20. Recommended Timeline

```text
Day 1:
App F skeleton, OIDC database tables, PID OIDC discovery + JWKS.

Day 2:
PID Authorization endpoint (+ resume), App F authorization + callback.

Day 3:
PID Token endpoint (+ UserInfo), App F token exchange + validation.

Day 4:
Regression testing, docs, launcher/script integration.
```

---

## 21. Protocol Comparison Reference

| Aspect                 | SAML (Existing)                                | OIDC (New)                              |
| ---------------------- | ---------------------------------------------- | --------------------------------------- |
| Message format         | XML                                            | JSON / JWT                              |
| Primary token          | Signed XML Assertion                           | Signed JWT (ID Token)                   |
| Flow type              | Redirect + auto-POST form                      | Redirect + background token POST        |
| User presence at SP    | Not required                                   | Not required                            |
| Token format           | XML (SOAP-ish)                                 | JWT (compact, URL-safe)                 |
| Mobile friendly        | Difficult                                      | Natural                                 |
| Complexity             | High (many bindings, profiles)                 | Lower (fewer flows, JSON-based)         |
| Industry adoption      | Enterprise (legacy)                            | Modern SaaS, mobile, SPAs               |
| Session hook in PID    | /saml/\*                                       | /authorize, /token                      |
| Database table         | saml_service_providers                         | oidc_clients                            |
| Demo app               | App E (port 3005, Node + @node-saml/node-saml) | App F (port 3006, Node + openid-client) |
| Signing library (PID)  | signxml + lxml                                 | pyjwt + cryptography                    |
| Token validation (App) | @node-saml/node-saml built-in                  | openid-client built-in                  |

---

## 22. Final Upgrade Statement

After this OIDC MVP, the project can be described as:

```text
Built a hybrid enterprise SSO platform supporting three authentication paradigms:
browser-extension credential replay for unmodified legacy applications,
SAML federated SSO using signed XML assertions for enterprise apps,
and OIDC federated SSO using JWT tokens for modern applications,
with PID acting as the central Identity Provider.
```
