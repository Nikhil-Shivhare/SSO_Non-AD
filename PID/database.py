"""
Primary Identity Service - Database Module (Python)

SQLite database setup with seed data.
1:1 behavioral clone of the Node.js db.js module.

Uses the SAME database.sqlite file as the Node.js version for seamless migration.
"""

import os
import json
import secrets
import sqlite3
import time

import bcrypt

# --------------------------------------------------------------------------
# CONFIG
# --------------------------------------------------------------------------

# Use own database (copy from Node.js PID on first run if not present)
DB_PATH = os.path.join(os.path.dirname(__file__), "database.sqlite")
SALT_ROUNDS = 10  # bcrypt rounds

# --------------------------------------------------------------------------
# CONNECTION HELPER
# --------------------------------------------------------------------------

def _get_db() -> sqlite3.Connection:
    """Get a new SQLite connection with row_factory for dict-like access."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")  # Enable FK enforcement
    return conn

# --------------------------------------------------------------------------
# DATABASE INITIALIZATION
# --------------------------------------------------------------------------

def init_database():
    """Create tables if they don't exist, run migrations, seed data."""
    conn = _get_db()
    cursor = conn.cursor()

    # Create tables
    cursor.executescript("""
        -- Users table
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
            vault_id TEXT
        );

        -- Applications registry
        CREATE TABLE IF NOT EXISTS apps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            appId TEXT UNIQUE NOT NULL,
            origin TEXT NOT NULL,
            login_schema TEXT DEFAULT NULL
        );

        -- User <-> App mapping
        CREATE TABLE IF NOT EXISTS user_apps (
            user_id INTEGER,
            app_id INTEGER,
            PRIMARY KEY (user_id, app_id),
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
        );

        -- Plugin tokens (for extension bootstrap)
        CREATE TABLE IF NOT EXISTS plugin_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT UNIQUE NOT NULL,
            user_id INTEGER NOT NULL,
            scopes TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );

        -- Password policy (singleton row, id always 1)
        CREATE TABLE IF NOT EXISTS password_policy (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            enabled INTEGER DEFAULT 1,
            min_length INTEGER DEFAULT 8,
            require_uppercase INTEGER DEFAULT 1,
            require_lowercase INTEGER DEFAULT 1,
            require_digit INTEGER DEFAULT 1,
            require_special INTEGER DEFAULT 1,
            special_chars TEXT DEFAULT '!@#$%%^&*()_+-=[]{}|;:,.<>?'
        );

        -- SAML Service Provider registry (separate from credential-replay 'apps' table)
        CREATE TABLE IF NOT EXISTS saml_service_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            entity_id TEXT UNIQUE NOT NULL,
            acs_url TEXT NOT NULL,
            name TEXT NOT NULL,
            enabled INTEGER DEFAULT 1,
            name_id_format TEXT DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
    """)

    # ── Migrate existing saml_service_providers if name_id_format column is missing
    sp_cols = [row[1] for row in cursor.execute("PRAGMA table_info(saml_service_providers)").fetchall()]
    if "name_id_format" not in sp_cols:
        cursor.execute(
            "ALTER TABLE saml_service_providers ADD COLUMN "
            "name_id_format TEXT DEFAULT 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified'"
        )

    # Seed password policy defaults if not present
    if not cursor.execute("SELECT id FROM password_policy WHERE id = 1").fetchone():
        cursor.execute(
            "INSERT INTO password_policy (id, enabled, min_length, require_uppercase, require_lowercase, require_digit, require_special, special_chars) VALUES (1, 1, 8, 1, 1, 1, 1, ?)",
            ("!@#$%^&*()_+-=[]{}|;:,.<>?",),
        )
        print("[DB] Seeded default password policy")

    # Migration: add vault_id column if missing
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN vault_id TEXT")
        print("[DB] Added vault_id column to existing users table")

        # Generate vault_id for existing users
        rows = cursor.execute("SELECT id FROM users WHERE vault_id IS NULL").fetchall()
        for row in rows:
            cursor.execute("UPDATE users SET vault_id = ? WHERE id = ?", (f"vault_{row['id']}", row["id"]))
        if rows:
            print(f"[DB] Generated vault_id for {len(rows)} existing users")
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            print(f"[DB] Migration error: {e}")

    # Migration: add is_active column if missing (default=1 means active)
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1")
        print("[DB] Added is_active column to existing users table")
        cursor.execute("UPDATE users SET is_active = 1 WHERE is_active IS NULL")
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            print(f"[DB] Migration error: {e}")

    # Migration: add login_url, logout_url, password_url columns to apps if missing
    for col, default_suffix in [("login_url", "/login"), ("logout_url", "/logout"), ("password_url", "/password")]:
        try:
            cursor.execute(f"ALTER TABLE apps ADD COLUMN {col} TEXT")
            # Back-fill from existing origin
            rows = cursor.execute("SELECT id, origin FROM apps WHERE {col} IS NULL".replace("{col}", col)).fetchall()
            for row in rows:
                cursor.execute(f"UPDATE apps SET {col} = ? WHERE id = ?", (row["origin"] + default_suffix, row["id"]))
            print(f"[DB] Added {col} column to apps table")
        except sqlite3.OperationalError as e:
            if "duplicate column" not in str(e).lower():
                print(f"[DB] Migration error ({col}): {e}")

    # Guard: fix any users with NULL or empty vault_id
    rows = cursor.execute("SELECT id, username FROM users WHERE vault_id IS NULL OR vault_id = ''").fetchall()
    for row in rows:
        vault_id = f"vault_{row['id']}"
        cursor.execute("UPDATE users SET vault_id = ? WHERE id = ?", (vault_id, row["id"]))
        print(f"[DB] Auto-assigned vault_id={vault_id} for user {row['username']}")

    conn.commit()

    # Seed if needed
    _seed_database(conn)
    conn.close()
    print("[DB] Database initialization complete")


def _seed_database(conn: sqlite3.Connection):
    """Seed default apps, users, and credentials if not already seeded."""
    cursor = conn.cursor()

    # Check if already seeded
    admin = cursor.execute("SELECT id FROM users WHERE username = ?", ("admin",)).fetchone()
    if admin:
        print("[DB] Database already seeded")
        return

    print("[DB] Seeding database...")

    # Default login schema (username + password)
    default_schema = json.dumps({
        "username": {"selector": "input[name='username']", "type": "text"},
        "password": {"selector": "input[name='password']", "type": "password"},
    })

    # Role-based login schema (App-D)
    role_schema = json.dumps({
        "username": {"selector": "input[name='username']", "type": "text"},
        "password": {"selector": "input[name='password']", "type": "password"},
        "role": {"selector": "select[name='role']", "type": "select"},
    })

    # Seed apps
    cursor.execute("INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)", ("app_a", "http://localhost:3001", default_schema))
    cursor.execute("INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)", ("app_b", "http://localhost:3002", default_schema))
    cursor.execute("INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)", ("app_c", "http://localhost:3003", default_schema))
    cursor.execute("INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)", ("app_d", "http://localhost:3004", role_schema))
    print("[DB] Seeded 4 apps (including App-D with role schema)")

    # Seed users
    admin_hash = bcrypt.hashpw(b"admin123", bcrypt.gensalt(SALT_ROUNDS)).decode()
    user_hash = bcrypt.hashpw(b"TestPass123!", bcrypt.gensalt(SALT_ROUNDS)).decode()

    cursor.execute("INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("admin", admin_hash, "admin"))
    cursor.execute("INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)", ("testuser", user_hash, "user"))

    # Set vault_id for seed users
    admin_row = cursor.execute("SELECT id FROM users WHERE username = ?", ("admin",)).fetchone()
    test_row = cursor.execute("SELECT id FROM users WHERE username = ?", ("testuser",)).fetchone()
    if admin_row:
        cursor.execute("UPDATE users SET vault_id = ? WHERE id = ?", (f"vault_{admin_row['id']}", admin_row["id"]))
    if test_row:
        cursor.execute("UPDATE users SET vault_id = ? WHERE id = ?", (f"vault_{test_row['id']}", test_row["id"]))

    print("[DB] Seeded 2 users: admin, testuser")

    # Assign all apps to testuser
    if test_row:
        test_user_id = test_row["id"]

        apps = cursor.execute("SELECT id, appId FROM apps").fetchall()
        for app in apps:
            cursor.execute("INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)", (test_user_id, app["id"]))
        print("[DB] Assigned all apps to testuser")

    conn.commit()
    # Note: Vault seeding is handled on first extension bootstrap (credentials already exist from Node.js PID)


# --------------------------------------------------------------------------
# USER FUNCTIONS
# --------------------------------------------------------------------------

def find_user_by_username(username: str) -> dict | None:
    """Find user by username. Returns dict or None."""
    conn = _get_db()
    row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    conn.close()
    return dict(row) if row else None


def find_user_by_id(user_id: int) -> dict | None:
    """Find user by ID. Returns dict or None."""
    conn = _get_db()
    row = conn.execute("SELECT id, username, role, vault_id, is_active FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def get_vault_id(user_id: int) -> str | None:
    """Get vault_id for a user."""
    conn = _get_db()
    row = conn.execute("SELECT vault_id FROM users WHERE id = ?", (user_id,)).fetchone()
    conn.close()
    return row["vault_id"] if row else None


def get_all_users() -> list[dict]:
    """Get all users."""
    conn = _get_db()
    rows = conn.execute("SELECT id, username, role, is_active FROM users").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def create_user(username: str, password: str, role: str = "user") -> dict:
    """Create a new user. Returns {success, userId} or {success, error}."""
    password_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(SALT_ROUNDS)).decode()

    conn = _get_db()
    try:
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            (username, password_hash, role),
        )
        user_id = cursor.lastrowid
        vault_id = f"vault_{user_id}"
        cursor.execute("UPDATE users SET vault_id = ? WHERE id = ?", (vault_id, user_id))
        conn.commit()
        conn.close()
        print(f"[DB] Created user {username} with id={user_id}, vault_id={vault_id}")
        return {"success": True, "userId": user_id}
    except sqlite3.IntegrityError:
        conn.close()
        return {"success": False, "error": "Username already exists"}


async def delete_user(user_id: int) -> dict:
    """Delete a user, cascade to vault and local tables."""
    from vault_client import delete_vault

    user = find_user_by_id(user_id)
    if user and user["role"] == "admin":
        return {"success": False, "error": "Cannot delete admin users"}

    # Delete from vault first
    vault_id = get_vault_id(user_id)
    if vault_id:
        vault_result = await delete_vault(vault_id)
        if not vault_result["success"]:
            print(f"[DB] Failed to delete vault for user {user_id}: {vault_result.get('error')}")
            return {"success": False, "error": "Failed to delete vault credentials"}
        print(f"[DB] Deleted vault credentials for user {user_id}")

    # Cascade delete local tables
    conn = _get_db()
    conn.execute("DELETE FROM user_apps WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM plugin_tokens WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()

    print(f"[DB] Deleted user {user_id} and all related data")
    return {"success": True}


def verify_password(user: dict, password: str) -> bool:
    """Verify password against stored hash."""
    return bcrypt.checkpw(password.encode(), user["password_hash"].encode())


def reset_user_password(user_id: int, new_password: str) -> dict:
    """Reset a user's password (admin action). Returns {success} or {success, error}."""
    user = find_user_by_id(user_id)
    if not user:
        return {"success": False, "error": "User not found"}

    # Validate against password policy
    validation = validate_password(new_password)
    if not validation["valid"]:
        return {"success": False, "error": "; ".join(validation["errors"])}

    password_hash = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt(SALT_ROUNDS)).decode()
    conn = _get_db()
    conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
    conn.commit()
    conn.close()

    # Revoke all tokens to force re-login
    revoke_user_tokens(user_id)
    print(f"[DB] Password reset for user {user['username']} (id={user_id}), tokens revoked")
    return {"success": True}


def toggle_user_active(user_id: int) -> dict:
    """Toggle is_active flag for a user. Returns {success, is_active}."""
    conn = _get_db()
    row = conn.execute("SELECT id, username, role, is_active FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        conn.close()
        return {"success": False, "error": "User not found"}
    if row["role"] == "admin":
        conn.close()
        return {"success": False, "error": "Cannot deactivate admin users"}

    new_status = 0 if row["is_active"] else 1
    conn.execute("UPDATE users SET is_active = ? WHERE id = ?", (new_status, user_id))
    conn.commit()
    conn.close()

    status_label = "activated" if new_status else "deactivated"
    print(f"[DB] User {row['username']} {status_label}")

    # If deactivating, revoke all tokens
    if not new_status:
        revoke_user_tokens(user_id)
        print(f"[DB] Revoked all tokens for deactivated user {row['username']}")

    return {"success": True, "is_active": bool(new_status)}


# --------------------------------------------------------------------------
# APP FUNCTIONS
# --------------------------------------------------------------------------

def get_all_apps() -> list[dict]:
    """Get all apps with user counts and schema type."""
    conn = _get_db()
    rows = conn.execute("""
        SELECT a.*, COUNT(ua.user_id) as user_count
        FROM apps a
        LEFT JOIN user_apps ua ON a.id = ua.app_id
        GROUP BY a.id
    """).fetchall()
    apps = []
    for r in rows:
        app = dict(r)
        schema = app.get("login_schema", "") or ""
        if schema == "SAML":
            app["schema_type"] = "SAML"
            sp = conn.execute("SELECT name, enabled FROM saml_service_providers WHERE entity_id = ?", (app["appId"],)).fetchone()
            app["name"] = sp["name"] if sp else app["appId"]
            app["enabled"] = bool(sp["enabled"]) if sp else True
        else:
            app["schema_type"] = "Role-based" if "role" in schema else "Standard"
            app["name"] = app["appId"]
            app["enabled"] = True
        apps.append(app)
    conn.close()
    return apps


def get_app_by_app_id(app_id: str) -> dict | None:
    """Get app by appId string."""
    conn = _get_db()
    row = conn.execute("SELECT * FROM apps WHERE appId = ?", (app_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def add_app(app_id: str, origin: str, login_schema: str,
            login_url: str = "", logout_url: str = "", password_url: str = "") -> dict:
    """Register a new application. Returns {success, error?}."""
    origin_clean = origin.strip().rstrip("/")
    # Derive defaults from origin if not supplied
    login_url = login_url.strip() or f"{origin_clean}/login"
    logout_url = logout_url.strip() or f"{origin_clean}/logout"
    password_url = password_url.strip() or f"{origin_clean}/password"

    conn = _get_db()
    try:
        conn.execute(
            "INSERT INTO apps (appId, origin, login_schema, login_url, logout_url, password_url) VALUES (?, ?, ?, ?, ?, ?)",
            (app_id.strip(), origin_clean, login_schema, login_url, logout_url, password_url),
        )
        conn.commit()
        print(f"[DB] Registered new app: {app_id} -> {origin_clean} (login: {login_url})")
        return {"success": True}
    except sqlite3.IntegrityError:
        return {"success": False, "error": f"App ID '{app_id}' already exists."}
    finally:
        conn.close()


def delete_app(app_id: str) -> dict:
    """Delete an application by appId. Returns {success, error?}."""
    conn = _get_db()
    try:
        # Check if it is a SAML SP
        app_row = conn.execute("SELECT id, login_schema FROM apps WHERE appId = ?", (app_id,)).fetchone()
        if not app_row:
            return {"success": False, "error": f"App '{app_id}' not found."}

        if app_row["login_schema"] == "SAML":
            # Delete from saml_service_providers table as well!
            conn.execute("DELETE FROM saml_service_providers WHERE entity_id = ?", (app_id,))

        conn.execute("DELETE FROM user_apps WHERE app_id = ?", (app_row["id"],))
        conn.execute("DELETE FROM apps WHERE appId = ?", (app_id,))
        conn.commit()
        print(f"[DB] Deleted app (and potential SAML SP): {app_id}")
        return {"success": True}
    finally:
        conn.close()


def get_user_apps(user_id: int) -> list[dict]:
    """Get all apps assigned to a user."""
    conn = _get_db()
    rows = conn.execute(
        """
        SELECT apps.* FROM apps
        INNER JOIN user_apps ON apps.id = user_apps.app_id
        WHERE user_apps.user_id = ?
        """,
        (user_id,),
    ).fetchall()
    apps = []
    for r in rows:
        app = dict(r)
        schema = app.get("login_schema", "") or ""
        if schema == "SAML":
            app["schema_type"] = "SAML"
            sp = conn.execute("SELECT name, enabled FROM saml_service_providers WHERE entity_id = ?", (app["appId"],)).fetchone()
            app["name"] = sp["name"] if sp else app["appId"]
            app["enabled"] = bool(sp["enabled"]) if sp else True
        else:
            app["schema_type"] = "Role-based" if "role" in schema else "Standard"
            app["name"] = app["appId"]
            app["enabled"] = True
        apps.append(app)
    conn.close()
    return apps


def assign_app_to_user(user_id: int, app_id: str) -> dict:
    """Assign an app to a user."""
    conn = _get_db()
    app = conn.execute("SELECT id FROM apps WHERE appId = ?", (app_id,)).fetchone()
    if not app:
        conn.close()
        return {"success": False, "error": "App not found"}

    try:
        conn.execute("INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)", (user_id, app["id"]))
        conn.commit()
        conn.close()
        return {"success": True}
    except Exception as err:
        conn.close()
        return {"success": False, "error": str(err)}


def remove_app_from_user(user_id: int, app_id: str) -> dict:
    """Remove an app from a user."""
    conn = _get_db()
    app = conn.execute("SELECT id FROM apps WHERE appId = ?", (app_id,)).fetchone()
    if not app:
        conn.close()
        return {"success": False, "error": "App not found"}

    conn.execute("DELETE FROM user_apps WHERE user_id = ? AND app_id = ?", (user_id, app["id"]))
    conn.commit()
    conn.close()
    return {"success": True}


def assign_all_apps_to_user(user_id: int) -> dict:
    """Assign all registered apps to a user."""
    conn = _get_db()
    apps = conn.execute("SELECT id FROM apps").fetchall()
    for app in apps:
        conn.execute("INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)", (user_id, app["id"]))
    conn.commit()
    conn.close()
    return {"success": True}


def remove_all_apps_from_user(user_id: int) -> dict:
    """Remove all apps from a user."""
    conn = _get_db()
    conn.execute("DELETE FROM user_apps WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()
    return {"success": True}


def is_user_allowed_app(user_id: int, app_id: str) -> bool:
    """Check if user is allowed to access an app."""
    conn = _get_db()
    app = conn.execute("SELECT id FROM apps WHERE appId = ?", (app_id,)).fetchone()
    if not app:
        conn.close()
        return False

    mapping = conn.execute(
        "SELECT * FROM user_apps WHERE user_id = ? AND app_id = ?", (user_id, app["id"])
    ).fetchone()
    conn.close()
    return mapping is not None


# --------------------------------------------------------------------------
# TOKEN FUNCTIONS
# --------------------------------------------------------------------------

def generate_plugin_token(user_id: int, scopes: list[str] = None, expires_in_seconds: int = 3600) -> dict:
    """Generate a plugin token for extension bootstrap."""
    if scopes is None:
        scopes = ["vault:read", "vault:write"]

    token = "ptk_" + secrets.token_hex(32)
    expires_at = int(time.time()) + expires_in_seconds

    conn = _get_db()
    conn.execute(
        "INSERT INTO plugin_tokens (token, user_id, scopes, expires_at) VALUES (?, ?, ?, ?)",
        (token, user_id, json.dumps(scopes), expires_at),
    )
    conn.commit()
    conn.close()

    return {"token": token, "expiresIn": expires_in_seconds}


def introspect_token(token: str) -> dict:
    """Validate a plugin token. Returns introspection result."""
    conn = _get_db()
    row = conn.execute("SELECT * FROM plugin_tokens WHERE token = ?", (token,)).fetchone()

    if not row:
        conn.close()
        return {"active": False, "error": "Token not found"}

    now = int(time.time())
    if now > row["expires_at"]:
        conn.execute("DELETE FROM plugin_tokens WHERE id = ?", (row["id"],))
        conn.commit()
        conn.close()
        return {"active": False, "error": "Token expired"}

    conn.close()

    user = find_user_by_id(row["user_id"])
    if not user:
        return {"active": False, "error": "User not found"}

    return {
        "active": True,
        "userId": row["user_id"],
        "username": user["username"],
        "is_active": user.get("is_active", 1),
        "scopes": json.loads(row["scopes"]),
    }


def revoke_user_tokens(user_id: int):
    """Revoke all plugin tokens for a user."""
    conn = _get_db()
    conn.execute("DELETE FROM plugin_tokens WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()


def get_app_with_schema(app_id: str) -> dict | None:
    """Get an app with its parsed loginSchema."""
    conn = _get_db()
    row = conn.execute("SELECT * FROM apps WHERE appId = ?", (app_id,)).fetchone()
    conn.close()

    if not row:
        return None

    return {
        "id": row["id"],
        "appId": row["appId"],
        "origin": row["origin"],
        "loginSchema": json.loads(row["login_schema"]) if row["login_schema"] else None,
    }


# --------------------------------------------------------------------------
# PASSWORD POLICY FUNCTIONS
# --------------------------------------------------------------------------

def get_password_policy() -> dict:
    """Get the current password policy. Returns dict with all fields."""
    conn = _get_db()
    row = conn.execute("SELECT * FROM password_policy WHERE id = 1").fetchone()
    conn.close()

    if not row:
        # Return defaults if somehow missing
        return {
            "enabled": True,
            "min_length": 8,
            "require_uppercase": True,
            "require_lowercase": True,
            "require_digit": True,
            "require_special": True,
            "special_chars": "!@#$%^&*()_+-=[]{}|;:,.<>?",
        }

    return {
        "enabled": bool(row["enabled"]),
        "min_length": row["min_length"],
        "require_uppercase": bool(row["require_uppercase"]),
        "require_lowercase": bool(row["require_lowercase"]),
        "require_digit": bool(row["require_digit"]),
        "require_special": bool(row["require_special"]),
        "special_chars": row["special_chars"] or "",
    }


def update_password_policy(
    enabled: bool = True,
    min_length: int = 8,
    require_uppercase: bool = True,
    require_lowercase: bool = True,
    require_digit: bool = True,
    require_special: bool = True,
    special_chars: str = "!@#$%^&*()_+-=[]{}|;:,.<>?",
) -> dict:
    """Update the password policy."""
    conn = _get_db()
    conn.execute(
        """UPDATE password_policy SET
            enabled = ?, min_length = ?, require_uppercase = ?,
            require_lowercase = ?, require_digit = ?,
            require_special = ?, special_chars = ?
        WHERE id = 1""",
        (int(enabled), min_length, int(require_uppercase),
         int(require_lowercase), int(require_digit),
         int(require_special), special_chars),
    )
    conn.commit()
    conn.close()
    print(f"[DB] Password policy updated: enabled={enabled}, min_length={min_length}")
    return {"success": True}


def validate_password(password: str) -> dict:
    """Validate password against current policy. Returns {valid, errors}."""
    policy = get_password_policy()

    # If policy is disabled, accept any password
    if not policy["enabled"]:
        return {"valid": True, "errors": []}

    errors = []

    if len(password) < policy["min_length"]:
        errors.append(f"Password must be at least {policy['min_length']} characters long")

    if policy["require_uppercase"] and not any(c.isupper() for c in password):
        errors.append("Password must contain at least 1 uppercase letter")

    if policy["require_lowercase"] and not any(c.islower() for c in password):
        errors.append("Password must contain at least 1 lowercase letter")

    if policy["require_digit"] and not any(c.isdigit() for c in password):
        errors.append("Password must contain at least 1 digit")

    if policy["require_special"]:
        special = policy["special_chars"]
        if special and not any(c in special for c in password):
            errors.append(f"Password must contain at least 1 special character ({special})")

    return {"valid": len(errors) == 0, "errors": errors}


def get_admin_stats() -> dict:
    """Get aggregate stats for admin overview."""
    conn = _get_db()
    total_users = conn.execute("SELECT COUNT(*) as c FROM users").fetchone()["c"]
    active_users = conn.execute("SELECT COUNT(*) as c FROM users WHERE is_active = 1").fetchone()["c"]
    inactive_users = total_users - active_users
    total_apps = conn.execute("SELECT COUNT(*) as c FROM apps").fetchone()["c"]
    active_tokens = conn.execute(
        "SELECT COUNT(*) as c FROM plugin_tokens WHERE expires_at > ?", (int(time.time()),)
    ).fetchone()["c"]
    conn.close()
    return {
        "total_users": total_users,
        "active_users": active_users,
        "inactive_users": inactive_users,
        "total_apps": total_apps,
        "active_tokens": active_tokens,
    }


def get_active_sessions() -> list:
    """Get active plugin tokens with user info (proxy for 'active sessions')."""
    conn = _get_db()
    now = int(time.time())
    rows = conn.execute("""
        SELECT u.username, u.role, pt.token, pt.expires_at, pt.scopes
        FROM plugin_tokens pt
        JOIN users u ON pt.user_id = u.id
        WHERE pt.expires_at > ?
        ORDER BY pt.expires_at DESC
    """, (now,)).fetchall()
    conn.close()

    sessions = []
    for r in rows:
        remaining = r["expires_at"] - now
        hours, remainder = divmod(remaining, 3600)
        minutes = remainder // 60
        sessions.append({
            "username": r["username"],
            "role": r["role"],
            "token_prefix": r["token"][:12] + "...",
            "expires_in": f"{hours}h {minutes}m",
            "scopes": r["scopes"],
        })
    return sessions


# --------------------------------------------------------------------------
# SAML SERVICE PROVIDER FUNCTIONS
# --------------------------------------------------------------------------

def get_saml_sp_by_entity_id(entity_id: str) -> dict | None:
    """Retrieve a SAML Service Provider record by its entity ID."""
    conn = _get_db()
    row = conn.execute(
        "SELECT * FROM saml_service_providers WHERE entity_id = ? AND enabled = 1",
        (entity_id,),
    ).fetchone()
    conn.close()
    return dict(row) if row else None


def get_enabled_saml_sps() -> list[dict]:
    """Return all enabled SAML Service Provider records."""
    conn = _get_db()
    rows = conn.execute(
        "SELECT * FROM saml_service_providers WHERE enabled = 1 ORDER BY name"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_saml_sps() -> list[dict]:
    """Return ALL SAML Service Provider records (enabled + disabled) for admin panel."""
    conn = _get_db()
    rows = conn.execute(
        "SELECT * FROM saml_service_providers ORDER BY name"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_saml_sp(name: str, entity_id: str, acs_url: str,
                nameid_format: str = "", enabled: bool = True) -> dict:
    """Add a new SAML Service Provider. Returns {ok, error}."""
    conn = _get_db()
    try:
        now = int(time.time())
        conn.execute(
            """
            INSERT INTO saml_service_providers
                (name, entity_id, acs_url, name_id_format, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (name.strip(), entity_id.strip(), acs_url.strip(),
             nameid_format.strip(), 1 if enabled else 0, now, now),
        )
        # Derive origin from ACS URL
        try:
            origin = "/".join(acs_url.split("/", 3)[:3])
        except Exception:
            origin = acs_url

        # Sync to apps table
        conn.execute(
            """
            INSERT OR IGNORE INTO apps (appId, origin, login_schema, login_url, logout_url, password_url)
            VALUES (?, ?, 'SAML', ?, '', '')
            """,
            (entity_id.strip(), origin, entity_id.strip())
        )
        conn.commit()
        return {"ok": True}
    except Exception as e:
        err = str(e)
        if "UNIQUE" in err.upper():
            return {"error": f"Entity ID already registered: {entity_id}"}
        return {"error": err}
    finally:
        conn.close()


def update_saml_sp(sp_id: int, name: str, entity_id: str, acs_url: str,
                   nameid_format: str = "", enabled: bool = True) -> dict:
    """Update an existing SAML SP row by its integer ID. Returns {ok, error}."""
    conn = _get_db()
    try:
        # Get old entity_id
        old_sp = conn.execute("SELECT entity_id FROM saml_service_providers WHERE id = ?", (sp_id,)).fetchone()
        old_entity_id = old_sp["entity_id"] if old_sp else None

        now = int(time.time())
        cur = conn.execute(
            """
            UPDATE saml_service_providers
               SET name = ?, entity_id = ?, acs_url = ?, name_id_format = ?,
                   enabled = ?, updated_at = ?
             WHERE id = ?
            """,
            (name.strip(), entity_id.strip(), acs_url.strip(),
             nameid_format.strip(), 1 if enabled else 0, now, sp_id),
        )
        if cur.rowcount == 0:
            return {"error": "SP not found"}

        # Update corresponding app in apps table
        if old_entity_id:
            try:
                origin = "/".join(acs_url.split("/", 3)[:3])
            except Exception:
                origin = acs_url
            conn.execute(
                """
                UPDATE apps
                   SET appId = ?, origin = ?, login_url = ?
                 WHERE appId = ?
                """,
                (entity_id.strip(), origin, entity_id.strip(), old_entity_id)
            )

        conn.commit()
        return {"ok": True}
    except Exception as e:
        err = str(e)
        if "UNIQUE" in err.upper():
            return {"error": f"Entity ID already registered: {entity_id}"}
        return {"error": err}
    finally:
        conn.close()


def delete_saml_sp(sp_id: int) -> dict:
    """Permanently delete a SAML SP by its integer ID. Returns {ok, error}."""
    conn = _get_db()
    try:
        # Get entity_id first
        sp = conn.execute("SELECT entity_id FROM saml_service_providers WHERE id = ?", (sp_id,)).fetchone()
        if sp:
            entity_id = sp["entity_id"]
            # Delete from user_apps assignment for this app
            app = conn.execute("SELECT id FROM apps WHERE appId = ?", (entity_id,)).fetchone()
            if app:
                conn.execute("DELETE FROM user_apps WHERE app_id = ?", (app["id"],))
                conn.execute("DELETE FROM apps WHERE appId = ?", (entity_id,))

        cur = conn.execute(
            "DELETE FROM saml_service_providers WHERE id = ?", (sp_id,)
        )
        conn.commit()
        if cur.rowcount == 0:
            return {"error": "SP not found"}
        return {"ok": True}
    except Exception as e:
        return {"error": str(e)}
    finally:
        conn.close()


def seed_saml_sp_if_missing():
    """Seed App E SP row if not already present (idempotent)."""
    conn = _get_db()
    # Update existing seed if it has the old name
    conn.execute(
        "UPDATE saml_service_providers SET name = ? WHERE entity_id = ? AND name = ?",
        ("app_e", "http://localhost:3005/saml/metadata", "App E SAML Demo")
    )
    conn.commit()

    existing = conn.execute(
        "SELECT id FROM saml_service_providers WHERE entity_id = ?",
        ("http://localhost:3005/saml/metadata",),
    ).fetchone()
    if not existing:
        now = int(time.time())
        conn.execute(
            """
            INSERT INTO saml_service_providers
                (entity_id, acs_url, name, enabled, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)
            """,
            (
                "http://localhost:3005/saml/metadata",
                "http://localhost:3005/saml/acs",
                "app_e",
                now,
                now,
            ),
        )
        # Also seed in apps table
        conn.execute(
            """
            INSERT OR IGNORE INTO apps (appId, origin, login_schema, login_url, logout_url, password_url)
            VALUES (?, ?, 'SAML', ?, '', '')
            """,
            (
                "http://localhost:3005/saml/metadata",
                "http://localhost:3005",
                "http://localhost:3005/saml/metadata"
            )
        )
        # Assign to testuser
        test_user = conn.execute("SELECT id FROM users WHERE username = ?", ("testuser",)).fetchone()
        app_row = conn.execute("SELECT id FROM apps WHERE appId = ?", ("http://localhost:3005/saml/metadata",)).fetchone()
        if test_user and app_row:
            conn.execute(
                "INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)",
                (test_user["id"], app_row["id"])
            )
        conn.commit()
        print("[DB] Seeded App E SAML Service Provider & App entry")
    else:
        # Ensure it also exists in apps table (for backward compatibility / existing database.sqlite files)
        app_exists = conn.execute("SELECT id FROM apps WHERE appId = ?", ("http://localhost:3005/saml/metadata",)).fetchone()
        if not app_exists:
            conn.execute(
                """
                INSERT OR IGNORE INTO apps (appId, origin, login_schema, login_url, logout_url, password_url)
                VALUES (?, ?, 'SAML', ?, '', '')
                """,
                (
                    "http://localhost:3005/saml/metadata",
                    "http://localhost:3005",
                    "http://localhost:3005/saml/metadata"
                )
            )
            test_user = conn.execute("SELECT id FROM users WHERE username = ?", ("testuser",)).fetchone()
            app_row = conn.execute("SELECT id FROM apps WHERE appId = ?", ("http://localhost:3005/saml/metadata",)).fetchone()
            if test_user and app_row:
                conn.execute(
                    "INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)",
                    (test_user["id"], app_row["id"])
                )
            conn.commit()
            print("[DB] Back-filled App E SAML Service Provider in apps table")
        print("[DB] SAML SP for App E already exists")
    conn.close()
