"""
Primary Identity Service - FastAPI Application (Python)

1:1 behavioral clone of the Node.js Express Primary Identity Service.
Port: 4000
Session Cookie: PID_SESSION (HTTP-Only)

All 19 routes replicated with identical JSON response schemas
to ensure SSO extension compatibility.

SECURITY NOTES (PoC only):
- Passwords in vault are stored as PLAIN TEXT
- pluginToken is a random string (not JWT)
- This component can be replaced with Keycloak in production
"""

import json
import os
import urllib.parse

from fastapi import FastAPI, Request, Form, Depends, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from starlette.middleware.sessions import SessionMiddleware
from slowapi import Limiter
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

import database as db
import vault_client

# ============================================================================
# APP SETUP
# ============================================================================

app = FastAPI(title="Primary Identity Service", docs_url=None, redoc_url=None)

# Session middleware — cookie name MUST be PID_SESSION for extension compatibility
app.add_middleware(
    SessionMiddleware,
    secret_key="primary-identity-poc-secret-change-in-production",
    session_cookie="PID_SESSION",
    max_age=24 * 60 * 60,  # 24 hours
    https_only=False,       # Set to True in production with HTTPS
)

# Rate limiting
limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter

@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    """Custom handler for rate limit exceeded — returns JSON for API, text for browser."""
    if request.url.path.startswith("/api"):
        return JSONResponse(
            status_code=429,
            content={"error": "Too many requests. Please slow down."},
        )
    return JSONResponse(
        status_code=429,
        content={"error": "Too many login attempts. Please try again after 15 minutes."},
    )

# Templates
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))


# ============================================================================
# STARTUP EVENT
# ============================================================================

@app.on_event("startup")
async def startup():
    """Initialize the database and check Vault health on startup."""
    db.init_database()

    # Check Vault Service health (warn-only, don't crash PID)
    vault_healthy = await vault_client.health_check()
    if vault_healthy:
        vault_url = os.environ.get("VAULT_URL", "http://localhost:5000")
        print(f"[VAULT] ✓ Vault Service reachable at {vault_url}")
    else:
        print("[VAULT] ⚠ Vault Service unreachable — credential operations will fail")
        print("[VAULT] Make sure Vault Service is running: cd vault-service && docker-compose up -d")

    print("========================================")
    print("Primary Identity Service (Python/FastAPI)")
    print("========================================")
    print("Running at: http://localhost:4000")
    print("Login page: http://localhost:4000/login")
    print("")
    print("Demo credentials:")
    print("  Admin: admin / admin123")
    print("  User:  testuser / TestPass123!")
    print("========================================")


# ============================================================================
# AUTH HELPERS
# ============================================================================

def get_session_user(request: Request) -> dict | None:
    """Extract user info from session. Returns None if not authenticated."""
    user_id = request.session.get("userId")
    if user_id is None:
        return None
    return {
        "userId": user_id,
        "username": request.session.get("username"),
        "role": request.session.get("role"),
    }


def require_auth(request: Request) -> dict:
    """Dependency: require authenticated session. Raises redirect if not."""
    user = get_session_user(request)
    if not user:
        raise HTTPException(status_code=302, headers={"Location": "/login"})
    return user


def require_admin(request: Request) -> dict:
    """Dependency: require admin session."""
    user = get_session_user(request)
    if not user or user["role"] != "admin":
        raise HTTPException(status_code=403, detail="Admin Access Required")
    return user


def require_bearer_token(request: Request) -> dict:
    """Dependency: require valid Bearer token in Authorization header."""
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = auth_header[7:]
    introspection = db.introspect_token(token)

    if not introspection.get("active"):
        raise HTTPException(status_code=401, detail=introspection.get("error", "Invalid token"))

    return introspection


# ============================================================================
# PUBLIC ROUTES
# ============================================================================

# GET /
@app.get("/")
async def root():
    """Root redirect to login."""
    return RedirectResponse(url="/login", status_code=302)


# GET /login
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Display the login page."""
    user = get_session_user(request)
    if user:
        return RedirectResponse(url="/dashboard", status_code=302)
    return templates.TemplateResponse("login.html", {"request": request, "title": "Login", "error": None})


# POST /login
@app.post("/login", response_class=HTMLResponse)
@limiter.limit("10/15minutes")
async def login_submit(request: Request, username: str = Form(...), password: str = Form(...)):
    """Process login form submission."""
    if not username or not password:
        return templates.TemplateResponse("login.html", {
            "request": request, "title": "Login", "error": "Username and password are required."
        })

    user = db.find_user_by_username(username)
    if not user or not db.verify_password(user, password):
        return templates.TemplateResponse("login.html", {
            "request": request, "title": "Login", "error": "Invalid username or password."
        })

    # Block deactivated users
    if not user.get("is_active", 1):
        return templates.TemplateResponse("login.html", {
            "request": request, "title": "Login", "error": "Your account has been deactivated. Contact an administrator."
        })

    # Create session
    request.session["userId"] = user["id"]
    request.session["username"] = user["username"]
    request.session["role"] = user["role"]

    print(f"[AUTH] User logged in: {user['username']} ({user['role']})")
    return RedirectResponse(url="/dashboard", status_code=302)


# GET /logout
@app.get("/logout")
async def logout(request: Request):
    """Logout: revoke tokens, destroy session."""
    user_id = request.session.get("userId")
    if user_id:
        db.revoke_user_tokens(user_id)
        print(f"[AUTH] User logged out: {request.session.get('username')}")
    request.session.clear()
    return RedirectResponse(url="/login", status_code=302)


# ============================================================================
# DASHBOARD (USER)
# ============================================================================

@app.get("/dashboard", response_class=HTMLResponse)
async def dashboard(request: Request):
    """User dashboard — shows assigned apps and SSO status."""
    session_user = get_session_user(request)
    if not session_user:
        return RedirectResponse(url="/login", status_code=302)

    user = db.find_user_by_id(session_user["userId"])
    user_apps = db.get_user_apps(session_user["userId"])

    return templates.TemplateResponse("dashboard.html", {
        "request": request,
        "title": "Dashboard",
        "username": user["username"],
        "role": user["role"],
        "apps": user_apps,
    })


# ============================================================================
# ADMIN PANEL
# ============================================================================

@app.get("/admin", response_class=HTMLResponse)
async def admin_panel(request: Request, message: str = "", error: str = ""):
    """Admin panel — user/app management."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        return HTMLResponse(
            content="<h1>403 - Admin Access Required</h1><p><a href='/login'>Login</a></p>",
            status_code=403,
        )

    users = db.get_all_users()
    all_apps = db.get_all_apps()

    # Enrich users with their assigned app list
    for user in users:
        user_apps = db.get_user_apps(user["id"])
        user["app_list"] = ", ".join(a["appId"] for a in user_apps) or "None"

    non_admin_users = [u for u in users if u["role"] != "admin"]

    # Get password policy + any query param messages
    policy = db.get_password_policy()
    policy_message = request.query_params.get("policy_message", "")

    # Stats for overview
    stats = db.get_admin_stats()
    active_sessions = db.get_active_sessions()

    # System info
    import sys
    import platform
    system_info = {
        "python_version": platform.python_version(),
        "os": f"{platform.system()} {platform.release()}",
        "db_path": db.DB_PATH,
        "pid_version": "2.0.0",
    }

    return templates.TemplateResponse("admin.html", {
        "request": request,
        "title": "Admin Panel",
        "message": message,
        "error": error,
        "users": users,
        "all_apps": all_apps,
        "non_admin_users": non_admin_users,
        "policy": policy,
        "policy_message": policy_message,
        "stats": stats,
        "active_sessions": active_sessions,
        "system_info": system_info,
    })


# POST /admin/users — Create user
@app.post("/admin/users")
async def admin_create_user(request: Request, username: str = Form(...), password: str = Form(...), role: str = Form("user")):
    """Create a new user (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    # Validate password against policy
    validation = db.validate_password(password)
    if not validation["valid"]:
        error_msg = "; ".join(validation["errors"])
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(error_msg)}", status_code=302)

    result = db.create_user(username, password, role)
    if result["success"]:
        print(f"[ADMIN] Created user: {username}")
        return RedirectResponse(url="/admin?message=User+created+successfully", status_code=302)
    else:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}", status_code=302)


# POST /admin/users/{id}/delete — Delete user
@app.post("/admin/users/{user_id}/delete")
async def admin_delete_user(request: Request, user_id: int):
    """Delete a user (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    result = await db.delete_user(user_id)
    if result["success"]:
        print(f"[ADMIN] Deleted user ID: {user_id}")
        return RedirectResponse(url="/admin?message=User+deleted", status_code=302)
    else:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}", status_code=302)


# POST /admin/users/{id}/toggle — Activate/Deactivate user
@app.post("/admin/users/{user_id}/toggle")
async def admin_toggle_user(request: Request, user_id: int):
    """Toggle user active/inactive status (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    result = db.toggle_user_active(user_id)
    if result["success"]:
        status = "activated" if result["is_active"] else "deactivated"
        print(f"[ADMIN] User {user_id} {status}")
        return RedirectResponse(url=f"/admin?message=User+{status}+successfully", status_code=302)
    else:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}", status_code=302)


# POST /admin/users/{id}/reset-password — Reset user password
@app.post("/admin/users/{user_id}/reset-password")
async def admin_reset_password(request: Request, user_id: int, new_password: str = Form(...)):
    """Reset a user's password (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    result = db.reset_user_password(user_id, new_password)
    if result["success"]:
        print(f"[ADMIN] Password reset for user {user_id}")
        return RedirectResponse(url="/admin?message=Password+reset+successfully", status_code=302)
    else:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}", status_code=302)


# POST /admin/assign-app — Assign app to user
@app.post("/admin/assign-app")
async def admin_assign_app(request: Request, userId: str = Form(...), appId: str = Form(...)):
    """Assign an app to a user (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    result = db.assign_app_to_user(int(userId), appId)
    if result["success"]:
        print(f"[ADMIN] Assigned {appId} to user {userId}")
        return RedirectResponse(url="/admin?message=App+assigned", status_code=302)
    else:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}", status_code=302)


# POST /admin/remove-app — Remove app from user
@app.post("/admin/remove-app")
async def admin_remove_app(request: Request, userId: str = Form(...), appId: str = Form(...)):
    """Remove an app from a user (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    result = db.remove_app_from_user(int(userId), appId)
    if result["success"]:
        print(f"[ADMIN] Removed {appId} from user {userId}")
        return RedirectResponse(url="/admin?message=App+removed", status_code=302)
    else:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}", status_code=302)


# POST /admin/password-policy — Update password policy
@app.post("/admin/password-policy")
async def admin_update_password_policy(
    request: Request,
    min_length: int = Form(8),
    special_chars: str = Form(""),
):
    """Update the password policy (admin only)."""
    session_user = get_session_user(request)
    if not session_user or session_user["role"] != "admin":
        raise HTTPException(status_code=403)

    # Parse form data — checkboxes only send value if checked
    form_data = await request.form()
    enabled = "enabled" in form_data
    require_uppercase = "require_uppercase" in form_data
    require_lowercase = "require_lowercase" in form_data
    require_digit = "require_digit" in form_data
    require_special = "require_special" in form_data

    db.update_password_policy(
        enabled=enabled,
        min_length=min_length,
        require_uppercase=require_uppercase,
        require_lowercase=require_lowercase,
        require_digit=require_digit,
        require_special=require_special,
        special_chars=special_chars,
    )

    status = "enabled" if enabled else "disabled"
    print(f"[ADMIN] Password policy updated: {status}, min_length={min_length}")
    return RedirectResponse(
        url=f"/admin?policy_message=Password+policy+{status}+successfully",
        status_code=302,
    )


# ============================================================================
# API: SESSION STATUS
# ============================================================================

@app.get("/api/session/status")
@limiter.limit("100/15minutes")
async def api_session_status(request: Request):
    """Return current session authentication status."""
    user = get_session_user(request)
    if user:
        return JSONResponse(content={
            "authenticated": True,
            "userId": user["userId"],
            "username": user["username"],
            "role": user["role"],
        })
    return JSONResponse(status_code=401, content={"authenticated": False})


# ============================================================================
# API: EXTENSION BOOTSTRAP
# ============================================================================

@app.post("/api/plugin/bootstrap")
@limiter.limit("100/15minutes")
async def api_bootstrap(request: Request):
    """Extension bootstrap — returns pluginToken and app list with schemas."""
    session_user = get_session_user(request)
    if not session_user:
        return JSONResponse(status_code=401, content={"error": "Not authenticated"})

    user_id = session_user["userId"]
    username = session_user["username"]

    # Generate plugin token
    token_data = db.generate_plugin_token(user_id)

    # Get user's allowed apps with login schemas
    user_apps = db.get_user_apps(user_id)
    apps = []
    for ua in user_apps:
        app_with_schema = db.get_app_with_schema(ua["appId"])
        apps.append({
            "appId": ua["appId"],
            "origin": ua["origin"],
            "loginSchema": app_with_schema["loginSchema"] if app_with_schema else None,
        })

    print(f"[BOOTSTRAP] Generated pluginToken for {username}, apps: {', '.join(a['appId'] for a in apps)}")

    return JSONResponse(content={
        "pluginToken": token_data["token"],
        "expiresIn": token_data["expiresIn"],
        "userId": user_id,
        "username": username,
        "apps": apps,
    })


# ============================================================================
# API: TOKEN INTROSPECTION
# ============================================================================

@app.post("/api/token/introspect")
@limiter.limit("100/15minutes")
async def api_introspect(request: Request):
    """Validate a pluginToken."""
    body = await request.json()
    plugin_token = body.get("pluginToken")

    if not plugin_token:
        return JSONResponse(status_code=400, content={"active": False, "error": "pluginToken is required"})

    result = db.introspect_token(plugin_token)

    # Block tokens for deactivated users
    if result.get("active") and not result.get("is_active", 1):
        return JSONResponse(content={"active": False, "error": "User account is deactivated"})

    return JSONResponse(content=result)


# ============================================================================
# API: VAULT CREDENTIALS
# ============================================================================

# GET /api/vault/credentials?appId=app_a
@app.get("/api/vault/credentials")
@limiter.limit("100/15minutes")
async def api_vault_get_credentials(request: Request, appId: str = ""):
    """Proxy to Vault Service — read credentials for an app."""
    token_data = require_bearer_token(request)
    user_id = token_data["userId"]

    if not appId:
        return JSONResponse(status_code=400, content={"error": "appId query parameter is required"})

    # Check if user is allowed to access this app
    if not db.is_user_allowed_app(user_id, appId):
        return JSONResponse(status_code=403, content={"error": "User not authorized for this app"})

    # Check scope
    if "vault:read" not in token_data.get("scopes", []):
        return JSONResponse(status_code=403, content={"error": "Token does not have vault:read scope"})

    # Get vault_id and call Vault Service
    vault_id = db.get_vault_id(user_id)
    if not vault_id:
        return JSONResponse(status_code=500, content={"error": "User vault_id not found"})

    result = await vault_client.read(vault_id, appId)

    if not result["success"]:
        return JSONResponse(status_code=result["status"], content={"error": result["error"]})

    print(f"[VAULT] Returned credentials for {token_data['username']} -> {appId}")

    return JSONResponse(content={
        "appId": appId,
        "fields": result["fields"],
    })


# POST /api/vault/credentials
@app.post("/api/vault/credentials")
@limiter.limit("100/15minutes")
async def api_vault_save_credentials(request: Request):
    """Proxy to Vault Service — save credentials for an app."""
    token_data = require_bearer_token(request)
    user_id = token_data["userId"]

    body = await request.json()
    app_id = body.get("appId")
    fields = body.get("fields")

    # Support both old format (username, password) and new format (fields)
    if not fields and body.get("username") and body.get("password"):
        fields = {"username": body["username"], "password": body["password"]}

    if not app_id or not fields or not fields.get("username") or not fields.get("password"):
        return JSONResponse(status_code=400, content={"error": "appId and fields (with username, password) are required"})

    # Check if user is allowed to access this app
    if not db.is_user_allowed_app(user_id, app_id):
        return JSONResponse(status_code=403, content={"error": "User not authorized for this app"})

    # Check scope
    if "vault:write" not in token_data.get("scopes", []):
        return JSONResponse(status_code=403, content={"error": "Token does not have vault:write scope"})

    # Get vault_id and call Vault Service
    vault_id = db.get_vault_id(user_id)
    if not vault_id:
        return JSONResponse(status_code=500, content={"error": "User vault_id not found"})

    result = await vault_client.write(vault_id, app_id, fields)

    if not result["success"]:
        return JSONResponse(status_code=result["status"], content={"error": result["error"]})

    print(f"[VAULT] Saved credentials for {token_data['username']} -> {app_id}")

    return JSONResponse(content={"success": True, "message": "Credentials saved"})


# PUT /api/vault/password — Update password only (for password change)
@app.put("/api/vault/password")
@limiter.limit("100/15minutes")
async def api_vault_update_password(request: Request):
    """Proxy to Vault Service — update password for an app."""
    token_data = require_bearer_token(request)
    user_id = token_data["userId"]

    body = await request.json()
    app_id = body.get("appId")
    new_password = body.get("newPassword")

    if not app_id or not new_password:
        return JSONResponse(status_code=400, content={"error": "appId and newPassword are required"})

    # Check if user is allowed to access this app
    if not db.is_user_allowed_app(user_id, app_id):
        return JSONResponse(status_code=403, content={"error": "User not authorized for this app"})

    # Check scope
    if "vault:write" not in token_data.get("scopes", []):
        return JSONResponse(status_code=403, content={"error": "Token does not have vault:write scope"})

    # Get vault_id and call Vault Service
    vault_id = db.get_vault_id(user_id)
    if not vault_id:
        return JSONResponse(status_code=500, content={"error": "User vault_id not found"})

    result = await vault_client.update_password(vault_id, app_id, new_password)

    if not result["success"]:
        return JSONResponse(status_code=result["status"], content={"error": result["error"]})

    print(f"[VAULT] Updated password for {token_data['username']} -> {app_id}")

    return JSONResponse(content={"success": True, "message": "Password updated"})


# ============================================================================
# MAIN ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=4000)
