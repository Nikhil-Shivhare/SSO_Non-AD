"""
PID OIDC Provider (oidc_provider.py)

Implements the PID side of the OIDC Authorization Code flow (MVP, HS256).

Routes registered:
  GET  /.well-known/openid-configuration  – Discovery document
  GET  /.well-known/jwks.json             – JWKS (empty keys list for HS256 MVP)
  GET  /authorize                         – Authorization endpoint
  POST /token                             – Token endpoint
  GET  /userinfo                          – UserInfo endpoint
  GET  /oidc/resume                       – Post-login resume endpoint (used by PID login hook)

Design follows the same functional pattern as saml_idp.py:
  - A FastAPI APIRouter (oidc_router) is registered in app.py.
  - Shared helper: generate_authorization_code() used from both /authorize and /oidc/resume.
  - No global mutable state.

Secret configuration:
  OIDC_HS256_SECRET env var (falls back to dev default; must be changed for production).
  Code TTL:  OIDC_CODE_TTL_SECONDS  (default 300 s)
  Token TTL: OIDC_TOKEN_TTL_SECONDS (default 3600 s)
"""

import os
import time
import secrets as _secrets
import urllib.parse
from datetime import datetime, timezone, timedelta

import jwt                          # pyjwt[crypto]>=2.8.0
from fastapi import APIRouter, Request, Form
from fastapi.responses import JSONResponse, RedirectResponse, HTMLResponse

import database as db

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

ISSUER = "http://localhost:4000"

# HS256 signing secret — loaded from env, MUST be overridden in production
_OIDC_SECRET = os.environ.get(
    "OIDC_HS256_SECRET",
    "pid_oidc_dev_secret_change_in_production_32chars_min",
)

CODE_TTL   = int(os.environ.get("OIDC_CODE_TTL_SECONDS",  "300"))   # 5 minutes
TOKEN_TTL  = int(os.environ.get("OIDC_TOKEN_TTL_SECONDS", "3600"))  # 1 hour

# --------------------------------------------------------------------------
# FastAPI router
# --------------------------------------------------------------------------

oidc_router = APIRouter()


# --------------------------------------------------------------------------
# Shared helper — used by /authorize (logged-in path) AND /oidc/resume
# --------------------------------------------------------------------------

def generate_authorization_code(
    client_id: str,
    user_id: int,
    redirect_uri: str,
    scope: str,
    nonce: str | None,
) -> str:
    """
    Generate a single-use authorization code, persist it in DB, and return it.
    Centralised so both /authorize and /oidc/resume always store nonce identically.
    """
    code = _secrets.token_urlsafe(32)
    expires_at = int(time.time()) + CODE_TTL
    db.create_oidc_authorization_code(
        code=code,
        client_id=client_id,
        user_id=user_id,
        redirect_uri=redirect_uri,
        scope=scope,
        nonce=nonce,
        expires_at=expires_at,
    )
    print(f"[OIDC] Generated authorization code for client={client_id} user_id={user_id}")
    return code


def _build_id_token(
    user_id: int,
    username: str,
    nonce: str | None,
    scope: str,
    client_id: str,
    client_secret: str,
) -> str:
    """
    Build and sign an HS256 ID Token JWT.

    Per RFC 7518 / OIDC Core §10.1, for HS256 the signing key IS the client_secret.
    openid-client v4 verifies the ID token using the registered client_secret, so we
    MUST sign with that value — NOT with the server's own _OIDC_SECRET.

    pyjwt gotchas:
      - 'algorithms' kwarg is REQUIRED on decode (we don't call decode here, but note it).
      - 'exp' must be a UTC integer timestamp.
      - Include 'aud' so openid-client can validate audience.
    """
    now = int(time.time())
    payload: dict = {
        "iss": ISSUER,
        "sub": username,               # subject = username (stable identifier)
        "aud": client_id,              # audience = the requesting client_id
        "iat": now,
        "exp": now + TOKEN_TTL,
        "name": username,
        "preferred_username": username,
    }
    if nonce:
        payload["nonce"] = nonce

    if "email" in scope:
        payload["email"] = f"{username}@example.local"

    # Sign with the CLIENT's secret — this is what openid-client will use to verify
    return jwt.encode(payload, client_secret, algorithm="HS256")


def _build_access_token(username: str, scope: str) -> str:
    """Build a short-lived access token JWT for /userinfo bearer auth."""
    now = int(time.time())
    payload = {
        "iss": ISSUER,
        "sub": username,
        "scope": scope,
        "iat": now,
        "exp": now + TOKEN_TTL,
        "token_use": "access",
    }
    return jwt.encode(payload, _OIDC_SECRET, algorithm="HS256")


def _decode_bearer_token(token: str) -> dict | None:
    """
    Decode and validate a Bearer access token.
    Returns claims dict on success, None on any failure.
    pyjwt gotcha: algorithms= kwarg is mandatory; omitting it raises DecodeError.
    """
    try:
        return jwt.decode(
            token,
            _OIDC_SECRET,
            algorithms=["HS256"],
            leeway=timedelta(seconds=30),  # tolerate up to 30s clock skew
            options={"verify_aud": False},  # access tokens don't carry aud in our MVP
        )
    except jwt.ExpiredSignatureError:
        print("[OIDC] Bearer token expired")
        return None
    except jwt.InvalidTokenError as exc:
        print(f"[OIDC] Bearer token invalid: {exc}")
        return None


# --------------------------------------------------------------------------
# PHASE 3 — Discovery and JWKS
# --------------------------------------------------------------------------

@oidc_router.get("/.well-known/openid-configuration")
async def oidc_discovery():
    """OIDC Discovery document (RFC 8414)."""
    return JSONResponse({
        "issuer": ISSUER,
        "authorization_endpoint": f"{ISSUER}/authorize",
        "token_endpoint":         f"{ISSUER}/token",
        "userinfo_endpoint":      f"{ISSUER}/userinfo",
        "jwks_uri":               f"{ISSUER}/.well-known/jwks.json",
        "response_types_supported":               ["code"],
        "subject_types_supported":                ["public"],
        "id_token_signing_alg_values_supported":  ["HS256"],
        "scopes_supported":                       ["openid", "profile", "email"],
        "token_endpoint_auth_methods_supported":  ["client_secret_post"],
        "grant_types_supported":                  ["authorization_code"],
        "claims_supported": [
            "sub", "iss", "aud", "exp", "iat",
            "name", "preferred_username", "email", "nonce",
        ],
    })


@oidc_router.get("/.well-known/jwks.json")
async def oidc_jwks():
    """
    JWKS endpoint.
    For HS256 MVP: return empty keys array.
    App F verifies tokens using client_secret directly (id_token_signed_response_alg=HS256).
    A symmetric key MUST NOT be published here — it would allow anyone to forge tokens.
    """
    return JSONResponse({"keys": []})


# --------------------------------------------------------------------------
# PHASE 4 — Authorization endpoint
# --------------------------------------------------------------------------

@oidc_router.get("/authorize")
async def oidc_authorize(request: Request):
    """
    OIDC Authorization endpoint (Authorization Code flow).

    Logged-in:    generate code → redirect to redirect_uri?code=...&state=...
    Not logged in: save pending state (including nonce) → redirect to /login
    """
    params = request.query_params

    client_id     = params.get("client_id", "").strip()
    redirect_uri  = params.get("redirect_uri", "").strip()
    response_type = params.get("response_type", "").strip()
    scope         = params.get("scope", "").strip()
    state         = params.get("state", "")
    nonce         = params.get("nonce", "") or None  # normalise empty string → None

    print(f"[OIDC] /authorize  client_id={client_id}  response_type={response_type}")

    # ── Validate response_type
    if response_type != "code":
        return JSONResponse(
            {"error": "unsupported_response_type",
             "error_description": "Only response_type=code is supported"},
            status_code=400,
        )

    # ── Validate scope includes openid
    if "openid" not in scope.split():
        return JSONResponse(
            {"error": "invalid_scope",
             "error_description": "scope must include openid"},
            status_code=400,
        )

    # ── Validate client
    client = db.get_oidc_client(client_id)
    if not client:
        return JSONResponse(
            {"error": "invalid_client",
             "error_description": f"Unknown or disabled client: {client_id}"},
            status_code=400,
        )

    # ── Validate redirect_uri against allowlist (open-redirect prevention)
    if redirect_uri not in client["redirect_uris"]:
        return JSONResponse(
            {"error": "invalid_redirect_uri",
             "error_description": "redirect_uri does not match registered value"},
            status_code=400,
        )

    # ── Check if user is already logged in
    user_id  = request.session.get("userId")
    username = request.session.get("username")

    if user_id and username:
        # Logged in — issue code immediately
        code = generate_authorization_code(
            client_id=client_id,
            user_id=int(user_id),
            redirect_uri=redirect_uri,
            scope=scope,
            nonce=nonce,
        )
        redirect_url = f"{redirect_uri}?code={urllib.parse.quote(code, safe='')}"
        if state:
            redirect_url += f"&state={urllib.parse.quote(state, safe='')}"
        print(f"[OIDC] User {username!r} already authenticated — redirecting with code")
        return RedirectResponse(url=redirect_url, status_code=302)

    # ── Not logged in — store full pending OIDC state and redirect to PID login
    # IMPORTANT: store scalar values only — Starlette signed-cookie limit is 4KB
    request.session["pending_oidc_request"] = {
        "client_id":    client_id,
        "redirect_uri": redirect_uri,
        "scope":        scope,
        "state":        state,
        "nonce":        nonce,   # must survive /login → /oidc/resume round-trip
    }
    print("[OIDC] User not logged in — saving pending OIDC state and redirecting to /login")
    return RedirectResponse(url="/login", status_code=302)


# --------------------------------------------------------------------------
# PHASE 5 — Resume route (called by PID login hook after successful login)
# --------------------------------------------------------------------------

@oidc_router.get("/oidc/resume")
async def oidc_resume(request: Request):
    """
    Post-login OIDC resume.
    Reads pending OIDC state from session, generates authorization code,
    redirects to redirect_uri?code=...&state=...
    Called automatically by the PID /login POST handler when pending_oidc_request is set.
    """
    user_id  = request.session.get("userId")
    username = request.session.get("username")

    if not user_id or not username:
        print("[OIDC] /oidc/resume: no authenticated session — redirecting to /login")
        return RedirectResponse(url="/login", status_code=302)

    pending = request.session.get("pending_oidc_request")
    if not pending:
        print("[OIDC] /oidc/resume: no pending OIDC request in session — redirecting to /dashboard")
        return RedirectResponse(url="/dashboard", status_code=302)

    client_id    = pending.get("client_id")
    redirect_uri = pending.get("redirect_uri")
    scope        = pending.get("scope", "openid")
    state        = pending.get("state", "")
    nonce        = pending.get("nonce")   # may be None

    # ── Re-validate client (belt-and-suspenders: client could be disabled between authorize and resume)
    client = db.get_oidc_client(client_id)
    if not client:
        del request.session["pending_oidc_request"]
        return JSONResponse(
            {"error": "invalid_client", "error_description": "Client no longer registered"},
            status_code=400,
        )

    if redirect_uri not in client["redirect_uris"]:
        del request.session["pending_oidc_request"]
        return JSONResponse(
            {"error": "invalid_redirect_uri", "error_description": "redirect_uri mismatch"},
            status_code=400,
        )

    # ── Generate code (nonce propagated through the chain: session → DB → JWT)
    code = generate_authorization_code(
        client_id=client_id,
        user_id=int(user_id),
        redirect_uri=redirect_uri,
        scope=scope,
        nonce=nonce,
    )

    # ── Clear pending state ONLY after successful code generation
    del request.session["pending_oidc_request"]

    redirect_url = f"{redirect_uri}?code={urllib.parse.quote(code, safe='')}"
    if state:
        redirect_url += f"&state={urllib.parse.quote(state, safe='')}"

    print(f"[OIDC] /oidc/resume: code issued for {username!r} → {redirect_uri}")
    return RedirectResponse(url=redirect_url, status_code=302)


# --------------------------------------------------------------------------
# PHASE 6 — Token endpoint
# --------------------------------------------------------------------------

@oidc_router.post("/token")
async def oidc_token(
    request: Request,
    grant_type:    str = Form(...),
    code:          str = Form(...),
    redirect_uri:  str = Form(...),
    client_id:     str = Form(...),
    client_secret: str = Form(...),
):
    """
    OIDC Token endpoint.
    Accepts: grant_type=authorization_code, code, redirect_uri, client_id, client_secret.
    Returns: JSON with access_token, id_token, token_type, expires_in.

    Auth method: client_secret_post (credentials in POST body).
    App F must set token_endpoint_auth_method='client_secret_post' in openid-client config.
    """
    print(f"[OIDC] /token  grant_type={grant_type}  client_id={client_id}")

    # ── Validate grant type
    if grant_type != "authorization_code":
        return JSONResponse(
            {"error": "unsupported_grant_type",
             "error_description": "Only grant_type=authorization_code is supported"},
            status_code=400,
        )

    # ── Validate client credentials (constant-time comparison via DB)
    if not db.verify_oidc_client_secret(client_id, client_secret):
        print(f"[OIDC] /token: invalid client credentials for {client_id!r}")
        return JSONResponse(
            {"error": "invalid_client",
             "error_description": "Client authentication failed"},
            status_code=401,
        )

    # ── Consume authorization code (validates expiry + single-use)
    code_row = db.consume_oidc_authorization_code(code)
    if not code_row:
        return JSONResponse(
            {"error": "invalid_grant",
             "error_description": "Authorization code is invalid, expired, or already used"},
            status_code=400,
        )

    # ── Validate code belongs to this client
    if code_row["client_id"] != client_id:
        return JSONResponse(
            {"error": "invalid_grant",
             "error_description": "Code was not issued to this client"},
            status_code=400,
        )

    # ── Validate redirect_uri matches exactly
    if code_row["redirect_uri"] != redirect_uri:
        return JSONResponse(
            {"error": "invalid_grant",
             "error_description": "redirect_uri does not match the one used in /authorize"},
            status_code=400,
        )

    # ── Look up user
    user = db.find_user_by_id(code_row["user_id"])
    if not user:
        return JSONResponse(
            {"error": "server_error",
             "error_description": "User not found"},
            status_code=500,
        )

    username = user["username"]
    scope    = code_row["scope"]
    nonce    = code_row.get("nonce")   # propagated from /authorize → DB → here

    # ── Fetch client record to get its secret (needed to sign the ID token)
    # Per OIDC spec, for HS256 the id_token MUST be signed with the client_secret
    # so that the RP (openid-client) can verify it with its own known secret.
    client_row = db.get_oidc_client(client_id)
    if not client_row:
        return JSONResponse(
            {"error": "server_error",
             "error_description": "Client disappeared between auth and token exchange"},
            status_code=500,
        )

    # ── Build tokens
    id_token = _build_id_token(
        user_id=user["id"],
        username=username,
        nonce=nonce,
        scope=scope,
        client_id=client_id,
        client_secret=client_row["client_secret"],
    )
    access_token = _build_access_token(username=username, scope=scope)

    print(f"[OIDC] /token: issued id_token+access_token for {username!r}")

    return JSONResponse({
        "access_token": access_token,
        "id_token":     id_token,
        "token_type":   "Bearer",
        "expires_in":   TOKEN_TTL,
        "scope":        scope,
    })


# --------------------------------------------------------------------------
# PHASE 7 — UserInfo endpoint
# --------------------------------------------------------------------------

@oidc_router.get("/userinfo")
async def oidc_userinfo(request: Request):
    """
    OIDC UserInfo endpoint.
    MVP: access token is a JWT — decode inline, no DB table needed.
    openid-client does NOT auto-call this; must call client.userinfo() explicitly.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.lower().startswith("bearer "):
        return JSONResponse(
            {"error": "invalid_token", "error_description": "Missing Bearer token"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )

    token = auth_header[len("Bearer "):].strip()
    claims = _decode_bearer_token(token)

    if not claims:
        return JSONResponse(
            {"error": "invalid_token", "error_description": "Token is expired or invalid"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer error=\"invalid_token\""},
        )

    username = claims.get("sub")
    scope    = claims.get("scope", "openid")

    response: dict = {"sub": username}

    if "profile" in scope:
        response["name"]               = username
        response["preferred_username"] = username

    if "email" in scope:
        response["email"] = f"{username}@example.local"

    print(f"[OIDC] /userinfo: returning claims for {username!r}")
    return JSONResponse(response)
