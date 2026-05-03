# SAML SSO MVP Implementation Plan

## 1. Objective

Add a second SSO category to the existing Non-AD SSO project without disturbing the current credential replay flow.

Current supported category:

```text
Credential Replay SSO
For unmodified legacy apps that only expose username/password forms.
Implemented using Chrome extension + PID + Vault.
```

New category to add:

```text
SAML Federated SSO
For apps that can integrate with a standards-based Identity Provider.
Implemented using PID as a SAML Identity Provider and one dummy app as a SAML Service Provider.
```

Final demo statement:

```text
This platform supports two SSO scenarios:
1. Browser extension credential replay SSO for unmodified legacy apps.
2. SAML federated SSO for applications that support standards-based federation.
```

## 2. Non-Negotiable Constraint

The current working project must not be affected.

Do not change:

- Existing browser extension behavior.
- Existing `/api/vault/*` APIs.
- Existing PID login/dashboard/admin behavior except for a small post-login redirect hook.
- Existing Apps A-D.
- Existing Vault Service behavior.
- Existing extension manifest matches.

Add SAML as a side-by-side feature:

```text
PID existing routes     -> unchanged
PID new SAML routes     -> /saml/*
New dummy SAML app      -> SAML App (App E), port 3005
New documentation       -> SAML_SSO.md and later a demo guide
```

## 3. MVP Scope

The MVP should implement only the minimum useful SAML flow:

- PID acts as SAML Identity Provider.
- One dummy app acts as SAML Service Provider.
- SP-initiated SSO only.
- User logs in through existing PID login.
- PID issues SAML response/assertion.
- Dummy app validates SAML response.
- Dummy app creates its own local session.
- User accesses dummy app dashboard without another password prompt if already logged into PID.

Out of scope for MVP:

- IdP-initiated SSO.
- SAML Single Logout.
- Encrypted assertions.
- Signed AuthnRequest validation.
- Admin UI for SAML apps.
- Multi-tenant SAML configuration.
- Dynamic metadata import.
- Production certificate management.

## 4. Target Demo Flow

### First-Time Flow

```text
1. User opens http://localhost:3005/login
2. SAML App E creates AuthnRequest.
3. App E redirects browser to:
   http://localhost:4000/saml/sso?SAMLRequest=...&RelayState=...
4. PID receives SAMLRequest.
5. PID checks whether user has PID_SESSION.
6. User is not logged in, so PID stores pending SAML request in session.
7. PID redirects user to /login.
8. User logs in using existing PID credentials.
9. PID detects pending SAML request after login.
10. PID continues SAML flow.
11. PID creates signed SAMLResponse.
12. Browser auto-posts SAMLResponse to App E /saml/acs.
13. App E verifies SAMLResponse.
14. App E creates local session.
15. User lands on App E dashboard.
```

### SSO Flow After PID Login

```text
1. User logs into PID once.
2. User opens http://localhost:3005/login.
3. App E redirects to PID /saml/sso.
4. PID sees existing PID_SESSION.
5. PID immediately returns signed SAMLResponse.
6. App E verifies response and opens dashboard.
7. User is not asked for password again.
```

## 5. Architecture

```text
Browser
  |
  | 1. Opens SAML App E
  v
SAML App E, Service Provider, port 3005
  |
  | 2. Redirects with SAMLRequest
  v
PID, SAML Identity Provider, port 4000
  |
  | 3. Uses existing PID session/login
  |
  | 4. Issues signed SAMLResponse
  v
SAML App E /saml/acs
  |
  | 5. Verifies response and creates app session
  v
SAML App E Dashboard
```

Important boundary:

```text
SAML SSO does not use Vault.
SAML SSO does not use the browser extension.
SAML SSO uses PID session as the central login session.
```

## 6. Suggested Files

Add new files:

```text
PID/saml_idp.py
PID/certs/dev-idp.key
PID/certs/dev-idp.crt
SAML App (App E)/app.js
SAML App (App E)/package.json
SAML App (App E)/README.md
```

Modify existing files carefully:

```text
PID/app.py
PID/database.py
PID/requirements.txt
```

Modify later, only after manual success:

```text
start-all.sh
stop-all.sh
launcher/app.js
README.md
```

Avoid modifying:

```text
sso-extension/*
vault-service/*
Session based App (App A)/*
Session + CSRF App (App B)/*
Stateless App (App C)/*
Role-based login App (App D)/*
```

## 7. Technology Choice

This decision is fixed for the MVP. Do not postpone it to implementation time.

### PID, SAML IdP

Use:

```text
lxml     -> XML construction/parsing
signxml  -> XML signature creation and verification helpers
```

Do not use `python3-saml` for the PID IdP MVP.

Reason:

- `python3-saml` is primarily built for Service Provider flows.
- The PID side in this project must act as an Identity Provider.
- Waiting to discover this during implementation would waste time and force a mid-build library switch.

Install:

```bash
pip install signxml lxml
```

For MVP, controlled XML generation is acceptable if:

- Assertion is signed.
- App E verifies signature.
- Time, audience, recipient, issuer, and InResponseTo are checked.
- XML is generated through `lxml`, not unsafe string concatenation.
- XML signing is handled by `signxml`, not custom crypto code.

### App E, SAML SP

Use Node.js Express, matching Apps A-D.

Use:

```text
@node-saml/node-saml -> SAML Service Provider flow
express-session     -> App E local session after SAML login
```

Install:

```bash
npm install @node-saml/node-saml express-session
```

`@node-saml/node-saml` should own the SP-side AuthnRequest creation and response validation wherever possible. In particular, wire its request ID storage/cache correctly so `InResponseTo` validation compares the returned SAMLResponse to the exact request App E generated.

Minimum App E SAML configuration rule:

```javascript
const { SAML } = require("@node-saml/node-saml");

const saml = new SAML({
  entryPoint: "http://localhost:4000/saml/sso",
  issuer: "http://localhost:3005/saml/metadata",
  callbackUrl: "http://localhost:3005/saml/acs",
  idpCert: pidPublicCertificate,
  validateInResponseTo: "always",
  requestIdExpirationPeriodMs: 5 * 60 * 1000,
  acceptedClockSkewMs: 2 * 60 * 1000,
});
```

`validateInResponseTo` defaults to `"never"` in `@node-saml/node-saml`, so setting it to `"always"` is mandatory for this MVP. The built-in in-memory cache provider is acceptable for the single-process demo, but if App E is ever scaled to multiple processes, replace it with a shared cache provider.

## 8. SAML Concepts Used In MVP

| SAML Concept | Meaning In This Project |
| --- | --- |
| Identity Provider, IdP | PID |
| Service Provider, SP | SAML App E |
| AuthnRequest | Request generated by App E asking PID to authenticate user |
| SAMLResponse | Response generated by PID and posted back to App E |
| Assertion | Signed identity statement inside SAMLResponse |
| ACS URL | App E endpoint that receives SAMLResponse |
| Entity ID | Unique identifier for PID or App E |
| RelayState | Opaque value used to preserve return path/state |
| NameID | User identifier, usually username or email |

## 9. PID SAML Routes

Add routes under `/saml/*`.

### `GET /saml/metadata`

Returns PID IdP metadata XML.

Contains:

- IdP entity ID.
- SSO service URL.
- Signing certificate.
- Supported binding.

Example values:

```text
IdP Entity ID: http://localhost:4000/saml/metadata
SSO URL:       http://localhost:4000/saml/sso
Binding:       HTTP-Redirect for request, HTTP-POST for response
```

### `GET /saml/sso`

Receives SAMLRequest from App E using redirect binding.

Responsibilities:

- Decode Redirect-binding SAMLRequest correctly:
  - base64 decode.
  - raw DEFLATE decompress.
  - parse decompressed XML bytes with `lxml`.
- Parse decoded SAMLRequest XML.
- Validate requested SP entity ID.
- Validate ACS URL against registry.
- Preserve RelayState.
- If user is not logged in, store pending SAML request in session and redirect to `/login`.
- If user is logged in, generate SAMLResponse.
- Return HTML form that auto-posts to App E ACS URL.

Required Redirect-binding decode helper:

```python
import base64
import zlib


def decode_redirect_saml_request(raw_saml_request: str) -> bytes:
    compressed = base64.b64decode(raw_saml_request)
    return zlib.decompress(compressed, -zlib.MAX_WBITS)
```

If base64 decoding or DEFLATE decompression fails, return `400 Invalid SAMLRequest`.

### `POST /saml/sso`

Optional for MVP.

Can support POST binding later. POST binding is different: the SAMLRequest is base64 encoded form data and is not raw-DEFLATE compressed.

## 10. Required Small Change In PID Login

After successful existing PID login, add a minimal hook:

```text
if request.session has pending_saml_request:
    redirect to /saml/sso/resume
else:
    redirect to /dashboard
```

Alternative:

```text
redirect back to /saml/sso with stored request data
```

Important:

- Normal PID login must still go to `/dashboard`.
- Extension bootstrap must remain unchanged.
- This hook should only run when pending SAML state exists.
- Preserve pending SAML state if login hardening clears or recreates session data.

Important implementation rule:

```python
# Capture before clearing/rebuilding login session data.
pending_saml = request.session.get("pending_saml_request")

# Existing project currently uses Starlette signed-cookie sessions, but the
# login code should still clear stale identity data before writing the new user.
request.session.clear()

request.session["userId"] = user["id"]
request.session["username"] = user["username"]
request.session["role"] = user["role"]

# Restore pending SAML flow into the fresh authenticated session.
if pending_saml:
    request.session["pending_saml_request"] = pending_saml
    return RedirectResponse(url="/saml/resume", status_code=302)

return RedirectResponse(url="/dashboard", status_code=302)
```

Clear `pending_saml_request` only after `/saml/resume` successfully creates the SAMLResponse auto-post page.

## 11. Optional Resume Route

Add:

```text
GET /saml/resume
```

Purpose:

- Read pending SAML request from PID session.
- Generate SAMLResponse after successful login.
- Clear pending state.
- Auto-post response to App E ACS.

This makes login integration cleaner and avoids rebuilding query strings.

## 12. PID Database Changes

Add one new table:

```sql
CREATE TABLE IF NOT EXISTS saml_service_providers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id TEXT UNIQUE NOT NULL,
    acs_url TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    name_id_format TEXT DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
```

Seed one SP:

```text
name: App E SAML Demo
entity_id: http://localhost:3005/saml/metadata
acs_url: http://localhost:3005/saml/acs
enabled: 1
```

Do not reuse the existing `apps` table in MVP.

Reason:

- Existing `apps` table is part of credential replay SSO.
- SAML apps have different config needs.
- Keeping a separate table prevents accidental impact on extension SSO.

## 13. SAML Assertion Contents

For MVP, PID should issue:

```text
Issuer:       http://localhost:4000/saml/metadata
Audience:     http://localhost:3005/saml/metadata
Recipient:    http://localhost:3005/saml/acs
NameID:       username
SessionIndex: generated unique value
NotBefore:    now - 2 minutes
NotOnOrAfter: now + 5 minutes
InResponseTo: exact AuthnRequest ID generated by App E
```

Attributes:

```text
username: testuser
role: user
email: testuser@example.local
```

Email can be synthetic for MVP because current PID users do not have email.

## 14. SAML App E Routes

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

Creates AuthnRequest and redirects to PID.

No username/password form in App E.

The page can show one button:

```text
Login with PID SAML SSO
```

For MVP, button can simply link to `/saml/login`.

### `GET /saml/login`

Generates AuthnRequest:

```text
SP Entity ID: http://localhost:3005/saml/metadata
ACS URL:      http://localhost:3005/saml/acs
```

Mandatory request ID handling:

```text
1. Generate AuthnRequest ID.
2. Save that ID in App E session as `saml_request_id`.
3. Redirect to PID with SAMLRequest.
```

Redirects to PID:

```text
http://localhost:4000/saml/sso?SAMLRequest=...&RelayState=...
```

### `POST /saml/acs`

Receives SAMLResponse.

Important middleware rule:

```text
Do not apply CSRF middleware to /saml/acs.
```

Reason:

```text
PID sends SAMLResponse to App E using a browser auto-post from a different origin.
Generic CSRF middleware will see this as a cross-origin POST and may reject it
before the SAML ACS handler can validate the signed response.
```

If App E later adds CSRF middleware, explicitly exclude `/saml/acs`:

```javascript
app.use((req, res, next) => {
  if (req.path === "/saml/acs") return next();
  return csrfMiddleware(req, res, next);
});
```

Validation checklist:

- Signature valid using PID public certificate.
- Issuer is PID.
- Audience is App E entity ID.
- Recipient is App E ACS URL.
- NotOnOrAfter is not expired.
- `SAMLResponse.InResponseTo === req.session.saml_request_id`.
- Response/request ID has not been replayed.

If valid:

- Create Express session.
- Store username, role, email, issuer, login time.
- Immediately delete `req.session.saml_request_id`.
- Redirect `/dashboard`.

If invalid:

- Return 401 with a short diagnostic message.

### `GET /dashboard`

Requires App E session.

Display:

```text
Logged in using SAML SSO
Username: testuser
Role: user
Email: testuser@example.local
Issuer: http://localhost:4000/saml/metadata
```

### `GET /logout`

Destroy only App E session.

MVP does not need global logout.

### `GET /saml/metadata`

Returns App E SP metadata.

Contains:

- SP entity ID.
- ACS URL.
- Optional SP certificate if later signing AuthnRequest.

## 15. Certificates And Keys

For MVP:

```text
PID/certs/dev-idp.key
PID/certs/dev-idp.crt
```

Rules:

- Mark as development-only.
- Do not use these in production.
- Later move to environment-configured path or secret manager.
- Add real secrets to `.gitignore`.
- Generate the key and certificate together in one command.
- Never replace only one of `dev-idp.key` or `dev-idp.crt`; they must stay a matched pair.

Generate both together, one time:

```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout PID/certs/dev-idp.key \
  -out PID/certs/dev-idp.crt \
  -days 365 -nodes \
  -subj "/CN=PID SAML Dev IdP"
```

Usage:

```text
dev-idp.key -> PID uses this private key to sign SAML assertions/responses.
dev-idp.crt -> PID embeds this public certificate in /saml/metadata.
dev-idp.crt -> App E uses this public certificate to verify PID signatures.
```

## 16. Configuration Values

Use environment variables where reasonable:

```text
SAML_IDP_ENTITY_ID=http://localhost:4000/saml/metadata
SAML_IDP_SSO_URL=http://localhost:4000/saml/sso
SAML_IDP_CERT_PATH=PID/certs/dev-idp.crt
SAML_IDP_KEY_PATH=PID/certs/dev-idp.key
SAML_ASSERTION_TTL_SECONDS=300
SAML_CLOCK_SKEW_SECONDS=120
```

For App E:

```text
APP_E_PORT=3005
APP_E_ENTITY_ID=http://localhost:3005/saml/metadata
APP_E_ACS_URL=http://localhost:3005/saml/acs
PID_SAML_METADATA_URL=http://localhost:4000/saml/metadata
```

## 17. Implementation Phases

### Phase 0: Safety Setup

Tasks:

- Create a feature branch.
- Confirm current services still run before SAML work.
- Do not touch extension or Apps A-D.

Validation:

```text
Existing PID login still works.
Existing extension SSO still works.
Existing Vault health endpoint still works.
```

### Phase 1: Add App E Skeleton

Tasks:

- Create `SAML App (App E)/package.json`.
- Create `SAML App (App E)/app.js`.
- Add basic Express server on port 3005.
- Add `/`, `/login`, `/dashboard`, `/logout`.

Validation:

```text
http://localhost:3005 opens.
Dashboard is protected.
Logout clears local App E session.
```

### Phase 2: Add SAML SP Metadata In App E

Tasks:

- Add `/saml/metadata`.
- Configure entity ID and ACS URL.

Validation:

```text
http://localhost:3005/saml/metadata returns XML.
Metadata contains App E entity ID and ACS URL.
```

### Phase 3: Add SAML SP Registry In PID

Tasks:

- Add `saml_service_providers` table.
- Add seed config for App E.
- Add helper functions:
  - `get_saml_sp_by_entity_id(entity_id)`
  - `get_enabled_saml_sps()`

Validation:

```text
SQLite table exists.
App E SP row exists.
Existing PID tables still exist unchanged.
```

### Phase 4: Add PID IdP Metadata

Tasks:

- Add `PID/saml_idp.py`.
- Add `/saml/metadata`.
- Load dev signing certificate.
- Return valid IdP metadata XML.

Validation:

```text
http://localhost:4000/saml/metadata returns XML.
Metadata contains PID entity ID.
Metadata contains signing certificate.
```

### Phase 5: Generate AuthnRequest From App E

Tasks:

- Add `/saml/login` in App E.
- Generate AuthnRequest using `@node-saml/node-saml`.
- Save the generated request ID in App E session as `saml_request_id`.
- Redirect to PID `/saml/sso`.
- Preserve RelayState.

Validation:

```text
Click "Login with PID SAML SSO".
Browser redirects to PID /saml/sso with SAMLRequest.
PID can at least parse or log the request.
```

### Phase 6: Add PID SSO Request Handling

Tasks:

- Add `/saml/sso`.
- Decode Redirect-binding SAMLRequest using base64 decode plus raw DEFLATE decompression:
  - `base64.b64decode(raw_saml_request)`
  - `zlib.decompress(decoded, -zlib.MAX_WBITS)`
- Return `400 Invalid SAMLRequest` if decode/decompression/parsing fails.
- Extract:
  - Request ID
  - Issuer
  - ACS URL
- Validate issuer against `saml_service_providers`.
- Validate ACS URL matches DB.
- If not logged in, store pending SAML data in session and redirect `/login`.
- If logged in, continue to response generation.

Validation:

```text
Unauthenticated user is redirected to PID login.
Authenticated user proceeds without login prompt.
Compressed Redirect-binding SAMLRequest is parsed successfully.
Malformed SAMLRequest returns 400 instead of crashing.
Invalid SP issuer is rejected.
Invalid ACS URL is rejected.
```

### Phase 7: Add SAML Resume After Login

Tasks:

- Add minimal post-login hook in PID.
- Add `/saml/resume` or equivalent.
- After user logs in, resume pending SAML request.
- Clear pending SAML data after use.

Validation:

```text
Opening App E while logged out sends user to PID login.
After login, user returns to App E automatically.
Normal PID login still redirects to /dashboard.
```

### Phase 8: Generate Signed SAMLResponse In PID

Tasks:

- Build SAMLResponse XML.
- Include assertion conditions.
- Include attributes.
- Sign assertion or response.
- Return auto-submit HTML form targeting App E ACS.

Validation:

```text
Browser receives an HTML form.
Form auto-posts SAMLResponse to App E /saml/acs.
SAMLResponse contains user identity.
```

### Phase 9: Verify SAMLResponse In App E

Tasks:

- Add `/saml/acs`.
- Ensure `/saml/acs` is not protected by generic CSRF middleware.
- Parse SAMLResponse.
- Verify signature.
- Validate issuer, audience, recipient, expiry, and InResponseTo.
- Compare `response.InResponseTo` to `req.session.saml_request_id`, not just field existence.
- Configure `@node-saml/node-saml` with `validateInResponseTo: "always"` and request ID caching so the library performs this exact comparison.
- Delete `req.session.saml_request_id` immediately after successful validation.
- Create App E session.
- Redirect dashboard.

Validation:

```text
Valid SAMLResponse logs user into App E.
Tampered SAMLResponse is rejected.
Expired SAMLResponse is rejected.
Wrong audience is rejected.
```

### Phase 10: Demo And Regression Testing

Test SAML:

```text
Case 1: App E -> PID login -> App E dashboard.
Case 2: PID already logged in -> App E dashboard without password.
Case 3: App E logout -> PID still logged in -> App E login works without password.
Case 4: Invalid SAMLResponse rejected.
Case 5: Expired SAMLResponse rejected.
```

Test old system:

```text
PID login still works.
Admin page still works.
Extension bootstrap still works.
Vault credential APIs still work.
Apps A-D still work.
```

### Phase 11: Add Launcher And Scripts

Only after SAML manual flow works:

- Add App E to launcher.
- Add App E start/stop in scripts.
- Add README section.
- Add short demo instructions.

## 18. Security Checklist

MVP must include:

- Signed SAMLResponse or signed assertion.
- Short assertion TTL.
- Audience validation.
- Recipient validation.
- Issuer validation.
- InResponseTo validation against the exact AuthnRequest ID stored in App E session.
- App E `@node-saml/node-saml` configured with `validateInResponseTo: "always"`.
- Immediate deletion of the stored App E request ID after successful ACS validation.
- ACS URL allowlist.
- SP entity ID allowlist.
- RelayState preserved but not trusted for arbitrary redirects.
- Request ID replay protection.
- PID Redirect-binding SAMLRequest decode uses base64 plus raw DEFLATE before XML parsing.
- `/saml/acs` excluded from generic CSRF middleware.
- No credential or token logging.

Can be added after MVP:

- Signed AuthnRequest validation.
- Encrypted assertions.
- IdP certificate rotation.
- Single Logout.
- Per-SP attribute mapping.
- Admin UI for SP registration.

## 19. Common Future Problems

### XML Signature Problems

SAML signatures are easy to implement incorrectly.

Mitigation:

- Prefer a maintained SAML/XML signature library.
- Avoid manual string concatenation for signed XML.
- Test tampered XML rejection.

### Clock Skew

Assertions may be rejected if machine clocks differ.

Mitigation:

- Use 2-minute skew tolerance.
- Keep assertion TTL short, around 5 minutes.

### Open Redirect Risk

RelayState can be abused if treated as a raw redirect URL.

Mitigation:

- Treat RelayState as opaque state.
- Store expected target in server-side session.
- Never redirect to arbitrary external URLs from RelayState.

### ACS URL Injection

Malicious request could ask PID to post SAMLResponse to attacker ACS.

Mitigation:

- Always lookup ACS URL from DB by SP entity ID.
- Ignore unregistered ACS URLs.

### Current App Breakage

SAML login changes could affect normal login.

Mitigation:

- Only add a post-login SAML hook when `pending_saml_request` exists.
- Capture pending SAML state before clearing/rebuilding login session data.
- Restore pending SAML state into the authenticated session before redirecting to `/saml/resume`.
- Clear pending SAML state only after response generation succeeds.
- Keep normal `/login` behavior otherwise unchanged.

### Request ID Validation Mistake

It is not enough to check that `InResponseTo` exists in the SAMLResponse.

Mitigation:

- App E must save the AuthnRequest ID it generated.
- App E must compare SAMLResponse `InResponseTo` to the saved ID.
- Configure `@node-saml/node-saml` with `validateInResponseTo: "always"`; the default is `"never"`.
- App E must delete the saved ID after successful ACS validation.
- Use the built-in in-memory request ID cache for the single-process MVP, or a shared cache if App E is ever scaled.

### Redirect Binding Decode Failure

HTTP-Redirect SAMLRequest values are not plain XML.

Mitigation:

- URL decoding is handled by the web framework query parser.
- PID must base64-decode the `SAMLRequest` value.
- PID must raw-DEFLATE decompress it using `zlib.decompress(decoded, -zlib.MAX_WBITS)`.
- Only then should PID parse the XML with `lxml`.
- Return `400 Invalid SAMLRequest` for malformed or non-decompressible requests.

### ACS CSRF Rejection

`/saml/acs` receives an auto-submitted POST from PID via the browser. Generic CSRF middleware may reject this before SAML validation runs.

Mitigation:

- Do not add CSRF middleware to App E in the MVP.
- If CSRF middleware is added later, explicitly exclude `/saml/acs`.
- Rely on SAML signature, issuer, audience, recipient, expiry, and InResponseTo checks for ACS security.

### Key Leakage

Development signing key might accidentally be treated as production key.

Mitigation:

- Name it `dev-idp.key`.
- Document it as local-only.
- Later move key path to environment variable.

### Certificate And Key Mismatch

If `dev-idp.key` and `dev-idp.crt` are not a matched pair, App E signature verification will fail with confusing invalid-signature errors.

Mitigation:

- Generate both files in the same `openssl req -x509 -newkey ...` command.
- Never replace only one file.
- If verification fails unexpectedly, first confirm the key/cert pair matches.

### SameSite Cookie Issues

SAML uses redirects and POSTs between apps.

Mitigation:

- For localhost MVP, existing cookies should work.
- In production, configure cookies carefully with HTTPS and SameSite rules.

## 20. Minimal Demo Script

### Demo 1: Existing Credential Replay SSO

```text
1. Login to PID.
2. Open App A or App D.
3. Extension fills and submits login form.
4. Explain: this works for apps that cannot be modified.
```

### Demo 2: New SAML Federated SSO

```text
1. Logout from PID and App E.
2. Open http://localhost:3005/login.
3. Click "Login with PID SAML SSO".
4. Browser goes to PID login.
5. Login as testuser.
6. Browser returns to App E dashboard.
7. Logout only from App E.
8. Open App E login again.
9. No PID password prompt appears because PID session exists.
10. App E dashboard opens again.
```

Interview explanation:

```text
For unmodified legacy apps, we use credential replay SSO through the browser extension.
For apps that support federation, PID acts as a SAML Identity Provider and issues signed assertions to a SAML Service Provider.
```

## 21. Acceptance Criteria

SAML MVP is complete when:

- App E can initiate SAML login.
- PID can act as IdP.
- PID metadata is available.
- App E metadata is available.
- User can login to App E through PID.
- User can access App E without re-login when PID session already exists.
- App E verifies SAMLResponse signature.
- Invalid or expired SAMLResponse is rejected.
- Existing credential replay SSO remains unaffected.

## 22. Recommended Timeline

```text
Day 1:
App E skeleton, SP metadata, PID SP registry.

Day 2:
PID IdP metadata, App E AuthnRequest, PID SSO request parsing.

Day 3:
PID signed SAMLResponse generation, App E ACS verification.

Day 4:
Regression testing, docs, launcher/script integration.
```

## 23. Final Resume Upgrade

After this MVP, the project can be described as:

```text
Built a hybrid enterprise SSO platform supporting browser-extension credential replay for unmodified legacy applications and SAML federated SSO for standards-compliant applications, with PID acting as the central Identity Provider.
```
