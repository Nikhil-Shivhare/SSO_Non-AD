# OIDC Admin UI, Registry Sync & Access Control — Implementation Plan

## 1. Objective

Add the missing pieces that make OIDC a first-class citizen in the unified SSO admin platform:

1. **Admin UI for OIDC Clients** — mirror the existing SAML SP admin UI exactly.
2. **Apps-table synchronization** — every OIDC client must also appear in the unified `apps` registry and user-assignment dropdowns, just like SAML SPs.
3. **Runtime authorization** — OIDC flows must respect user-to-app assignments (same `is_user_allowed_app` check already used by SAML).
4. **Dashboard + dropdowns enrichment** — OIDC apps show their friendly name and a purple OIDC badge.
5. **Fix seed inconsistency** — App F seed currently writes only to `oidc_clients`, not `apps`, so it is invisible to `get_all_apps()` and user-assignment UIs until the first manual `add_oidc_client` call.

Non-negotiable rules (same as before):
- Do not touch `sso-extension/*`, `vault-service/*`, Apps A–D, or `saml_idp.py`.
- Existing SAML behavior must remain byte-for-byte identical.
- Existing PID login, session handling, and extension bootstrap must remain unchanged.

---

## 2. Gap Analysis (Current State → Target State)

| Area | Current OIDC State | Target State |
|------|-------------------|--------------|
| DB functions | `get_oidc_client`, `verify_oidc_client_secret`, `seed_oidc_client_if_missing` only | Add `get_all_oidc_clients`, `add_oidc_client`, `update_oidc_client`, `delete_oidc_client` |
| Apps-table sync | Seed writes only to `oidc_clients`; `add_oidc_client` does not exist | Every OIDC client mirrors into `apps` (login_schema = 'OIDC') |
| delete_app cascade | SAML cascades to `saml_service_providers` | Also cascade to `oidc_clients` |
| delete_oidc_client | Does not exist | Must delete `oidc_clients` row + matching `apps` row + `user_apps` rows |
| Admin API routes | None | `POST /admin/oidc-clients`, `/{id}/update`, `/{id}/delete` |
| Admin UI | No OIDC section, no stats card, no badges | Full SAML-mirrored section + purple OIDC badge in apps grid |
| Dropdowns | `get_all_apps` / `get_user_apps` do not detect OIDC | Enrich with OIDC `name` and `enabled`, show `(OIDC)` suffix |
| Dashboard | Shows raw `appId` | Shows friendly OIDC name + purple badge + correct link |
| OIDC runtime auth | `/authorize` and `/oidc/resume` skip `is_user_allowed_app` | Block unauthorized users with branded 403 page (exact SAML pattern) |
| oidc_provider client lookup | `db.get_oidc_client(client_id)` — only returns enabled clients | `/token` needs ability to look up by client_id regardless of enabled, OR reuse `get_oidc_client` and accept that disabled clients can still exchange codes (acceptable for MVP because `apps` table missing_app_id is the stronger gatekeeper — but cleaner to add `get_oidc_client_by_client_id_any`) |

---

## 3. Database Changes (`PID/database.py`)

### 3.1 Fix Seed Function

**Current `seed_oidc_client_if_missing` (line 1152):**
```python
def seed_oidc_client_if_missing():
    conn = _get_db()
    existing = conn.execute("SELECT id FROM oidc_clients WHERE client_id = ?", ("app_f",)).fetchone()
    if not existing:
        now = int(time.time())
        redirect_uris_json = json.dumps(["http://localhost:3006/callback"])
        conn.execute("INSERT INTO oidc_clients ... VALUES (?, ?, ?, ?, 1, ?, ?)",
            ("app_f", "app_f_secret_development_only", "App F OIDC Demo", redirect_uris_json, now, now))
        conn.commit()
    conn.close()
```

**Updated seed function:**
- Insert into `oidc_clients` (same as today).
- Also `INSERT OR IGNORE INTO apps (appId, origin, login_schema, login_url, logout_url, password_url) VALUES (?, ?, 'OIDC', '', '', '')` with `appId = 'app_f'` and `origin = 'http://localhost:3006'`.
- This ensures App F appears in `get_all_apps()` immediately on first run.

### 3.2 New CRUD Functions for OIDC

#### `get_all_oidc_clients() -> list[dict]`
```python
def get_all_oidc_clients() -> list[dict]:
    """Return all OIDC clients, ordered by name."""
    conn = _get_db()
    rows = conn.execute("SELECT * FROM oidc_clients ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]
```

#### `add_oidc_client(name, client_id, client_secret, redirect_uris, enabled) -> dict`
- Insert into `oidc_clients`.
- Derive origin from first URI (same SAML pattern: `"/".join(redirect_uris[0].split("/", 3)[:3])`).
- `INSERT OR IGNORE INTO apps (appId, origin, login_schema, login_url, logout_url, password_url) VALUES (client_id, origin, 'OIDC', '', '', '')`.
- Return `{"ok": True}` or `{"error": ...}`.

**Validation rules:**
- `name` and `client_id` required, non-empty.
- `redirect_uris` must parse as JSON list; reject if empty.
- If `client_id` already exists in `oidc_clients`, return UNIQUE error (etc).
- `enabled` cast to 0/1.

#### `update_oidc_client(client_id, name, client_secret, redirect_uris, enabled) -> dict`
- `client_id` is immutable — do NOT allow changing it.
- Update `oidc_clients` set `name = ?, client_secret = ?, redirect_uris = ?, enabled = ?, updated_at = ?` where `client_id = ?`.
- If `name` or first redirect URI changed, propagate to `apps` table: `UPDATE apps SET appId = ?, origin = ? WHERE appId = ?` (note: we allow changing `appId` here only if caller does not change it, so actually just `UPDATE apps SET origin = ? WHERE appId = ?`).
- Return `{"ok": True}` or `{"error": ...}`.

**Rationale for immutable client_id:** it is the PK of `oidc_clients` and the `appId` value in `apps`, `user_apps`, and JWT `aud` claims. Changing it mid-flight breaks token validation and user assignments. SAML allows entity_id changes via swap, but that is unnecessary complexity for OIDC MVP.

#### `delete_oidc_client(client_id) -> dict`
- Find the matching `apps.id` via `SELECT id FROM apps WHERE appId = ?`.
- `DELETE FROM user_apps WHERE app_id = ?` (using the apps row id).
- `DELETE FROM apps WHERE appId = ?`.
- `DELETE FROM oidc_clients WHERE client_id = ?`.
- Return `{"ok": True}` or `{"error": ...}`.

### 3.3 Extend `delete_app(app_id)` Cascade

**Current `delete_app` (line 472):**
```python
if app_row["login_schema"] == "SAML":
    conn.execute("DELETE FROM saml_service_providers WHERE entity_id = ?", (app_id,))
```

**Updated:**
```python
if app_row["login_schema"] == "SAML":
    conn.execute("DELETE FROM saml_service_providers WHERE entity_id = ?", (app_id,))
elif app_row["login_schema"] == "OIDC":
    conn.execute("DELETE FROM oidc_clients WHERE client_id = ?", (app_id,))
```

### 3.4 Enrich `get_all_apps()` and `get_user_apps()`

**Current enrichment (lines 425–434):**
```python
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
```

**Updated:**
```python
schema = app.get("login_schema", "") or ""
if schema == "SAML":
    app["schema_type"] = "SAML"
    sp = conn.execute("SELECT name, enabled FROM saml_service_providers WHERE entity_id = ?", (app["appId"],)).fetchone()
    app["name"] = sp["name"] if sp else app["appId"]
    app["enabled"] = bool(sp["enabled"]) if sp else True
elif schema == "OIDC":
    app["schema_type"] = "OIDC"
    client = conn.execute("SELECT name, enabled FROM oidc_clients WHERE client_id = ?", (app["appId"],)).fetchone()
    app["name"] = client["name"] if client else app["appId"]
    app["enabled"] = bool(client["enabled"]) if client else True
else:
    app["schema_type"] = "Role-based" if "role" in schema else "Standard"
    app["name"] = app["appId"]
    app["enabled"] = True
```

This change alone fixes every dropdown and dashboard card for OIDC without touching any template logic for the main apps grid — the existing `{% if app.schema_type == 'SAML' %}` block just needs an `elif`.

---

## 4. Admin Controller & Routes (`PID/app.py`)

### 4.1 Pass OIDC Clients to Admin Template

**Current `admin_panel()` route (around line 340):**
```python
saml_sps = db.get_all_saml_sps()
# ...
return TemplateResponse("admin.html", {
    # ...
    "saml_sps": saml_sps,
})
```

**Updated:**
```python
oidc_clients = db.get_all_oidc_clients()
# ...
return TemplateResponse("admin.html", {
    # ...
    "saml_sps": saml_sps,
    "oidc_clients": oidc_clients,
})
```

### 4.2 New Admin OIDC Routes

#### `POST /admin/oidc-clients`
```python
@app.post("/admin/oidc-clients")
async def admin_add_oidc_client(request: Request, name: str = Form(...), client_id: str = Form(...), client_secret: str = Form(...), redirect_uris: str = Form(...), enabled: str = Form("0")):
    result = db.add_oidc_client(
        name=name.strip(),
        client_id=client_id.strip(),
        client_secret=client_secret.strip(),
        redirect_uris=redirect_uris.strip(),
        enabled=(enabled == "1"),
    )
    if "error" in result:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}#oidc-apps", status_code=302)
    return RedirectResponse(url=f"/admin?message={urllib.parse.quote('OIDC client registered successfully')}#oidc-apps", status_code=302)
```

#### `POST /admin/oidc-clients/{client_id}/update`
```python
@app.post("/admin/oidc-clients/{client_id}/update")
async def admin_update_oidc_client(request: Request, client_id: str, name: str = Form(...), client_secret: str = Form(...), redirect_uris: str = Form(...), enabled: str = Form("0")):
    result = db.update_oidc_client(
        client_id=client_id.strip(),
        name=name.strip(),
        client_secret=client_secret.strip(),
        redirect_uris=redirect_uris.strip(),
        enabled=(enabled == "1"),
    )
    if "error" in result:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}#oidc-apps", status_code=302)
    return RedirectResponse(url=f"/admin?message={urllib.parse.quote('OIDC client updated')}#oidc-apps", status_code=302)
```

#### `POST /admin/oidc-clients/{client_id}/delete`
```python
@app.post("/admin/oidc-clients/{client_id}/delete")
async def admin_delete_oidc_client(request: Request, client_id: str):
    result = db.delete_oidc_client(client_id.strip())
    if "error" in result:
        return RedirectResponse(url=f"/admin?error={urllib.parse.quote(result['error'])}#oidc-apps", status_code=302)
    return RedirectResponse(url=f"/admin?message={urllib.parse.quote('OIDC client deleted')}#oidc-apps", status_code=302)
```

Place these routes immediately after the existing SAML admin routes (after line 644), grouped under an `# ── ADMIN OIDC CLIENT MANAGEMENT ──` comment.

---

## 5. Admin UI (`PID/templates/admin.html`)

All additions mirror the SAML section structure exactly.

### 5.1 Stats Card

Add a new stat card between the existing SAML card and the closing `</div>` of the stats row:

```html
<div class="stat-card" style="border-top:3px solid #8e44ad;">
    <div class="stat-number" style="color:#8e44ad;">{{ oidc_clients | length }}</div>
    <div class="stat-label">OIDC Clients</div>
</div>
```

Insert after the SAML stat (around line 213) and before `</div></div>`.

### 5.2 Sidebar Navigation

Add after the existing `SAML Apps` link (around line 164):
```html
<a href="#oidc-apps">OIDC Clients</a>
```

### 5.3 OIDC Clients Section (New div after SAML Apps section, before Password Policy)

```html
<!-- OIDC CLIENTS -->
<div class="admin-section" id="oidc-apps">
    <h2>OIDC Relying Parties
        <span style="font-size:12px;font-weight:400;color:#7f8c8d;margin-left:8px;">Managed by PID OpenID Connect Provider</span>
    </h2>

    <!-- Clients list table -->
    {% if oidc_clients %}
    <table style="margin-top:8px;">
        <thead>
            <tr>
                <th>#</th>
                <th>Name</th>
                <th>Client ID</th>
                <th>Client Secret</th>
                <th>Redirect URIs</th>
                <th>Status</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>
            {% for client in oidc_clients %}
            <tr id="oidc-client-row-{{ client.client_id }}">
                <td style="color:#95a5a6;">{{ client.id }}</td>
                <td><strong>{{ client.name }}</strong></td>
                <td><code style="font-size:11px;">{{ client.client_id }}</code></td>
                <td><code style="font-size:11px;">{{ client.client_secret }}</code></td>
                <td><code style="font-size:11px;">{{ client.redirect_uris }}</code></td>
                <td>
                    {% if client.enabled %}
                    <span class="badge" style="background:#27ae60;color:white;">Enabled</span>
                    {% else %}
                    <span class="badge" style="background:#95a5a6;color:white;">Disabled</span>
                    {% endif %}
                </td>
                <td style="white-space:nowrap;">
                    <button type="button" class="btn-primary"
                        onclick="openOidcEdit('{{ client.client_id|e }}', '{{ client.name|e }}', '{{ client.client_secret|e }}', '{{ client.redirect_uris|e }}', {{ 1 if client.enabled else 0 }})"
                    >Edit</button>
                </td>
            </tr>
            {% endfor %}
        </tbody>
    </table>
    {% else %}
    <p style="color:#95a5a6;font-size:13px;margin-top:8px;">No OIDC clients registered yet.</p>
    {% endif %}

    <!-- EDIT MODAL -->
    <div id="oidc-edit-modal" style="display:none;margin-top:20px;padding:18px;border:1px solid #d5b9d5;border-radius:8px;background:#fdf5fd;">
        <h3 style="margin-top:0;font-size:14px;color:#6c3483;">✏️ Edit OIDC Client</h3>
        <form method="POST" id="oidc-edit-form" action="">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px;">
                <div>
                    <label>Name <span style="color:#e74c3c;">*</span></label>
                    <input type="text" name="name" id="edit-oidc-name" required>
                </div>
                <div>
                    <label>Status</label>
                    <div style="margin-top:8px;">
                        <label style="display:inline;">
                            <input type="checkbox" name="enabled" value="1" id="edit-oidc-enabled"> Enabled
                        </label>
                    </div>
                </div>
            </div>
            <div style="margin-bottom:12px;">
                <label>Client ID</label>
                <input type="text" id="edit-oidc-client-id" disabled style="width:100%;box-sizing:border-box;background:#f0f0f0;color:#7f8c8d;">
                <small style="color:#95a5a6;">Client ID is immutable after creation.</small>
            </div>
            <div style="margin-bottom:12px;">
                <label>Client Secret <span style="color:#e74c3c;">*</span></label>
                <input type="text" name="client_secret" id="edit-oidc-secret" required style="width:100%;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:16px;">
                <label>Redirect URIs <span style="color:#e74c3c;">*</span></label>
                <textarea name="redirect_uris" id="edit-oidc-redirects" rows="3" required style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;">{{ client.redirect_uris }}</textarea>
                <small style="color:#95a5a6;">JSON array of strings, e.g. ["http://localhost:3006/callback"]</small>
            </div>
            <div style="display:flex;gap:10px;">
                <button type="submit" class="btn-success">Save Changes</button>
                <button type="button" class="btn-warning" onclick="closeOidcEdit()">Cancel</button>
            </div>
        </form>
    </div>

    <!-- ADD NEW CLIENT FORM -->
    <div style="margin-top:24px;">
        <h3 style="font-size:14px;color:#2c3e50;margin-bottom:12px;">+ Register New OIDC Client</h3>
        <form method="POST" action="/admin/oidc-clients">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px;">
                <div>
                    <label>Name <span style="color:#e74c3c;">*</span></label>
                    <input type="text" name="name" required placeholder="e.g. My OIDC App" style="width:100%;box-sizing:border-box;">
                </div>
                <div>
                    <label style="display:block;margin-bottom:4px;">Status</label>
                    <label style="display:inline;">
                        <input type="checkbox" name="enabled" value="1" checked> Enabled
                    </label>
                </div>
            </div>
            <div style="margin-bottom:12px;">
                <label>Client ID <span style="color:#e74c3c;">*</span></label>
                <input type="text" name="client_id" required placeholder="e.g. app_f" style="width:100%;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:12px;">
                <label>Client Secret <span style="color:#e74c3c;">*</span></label>
                <input type="text" name="client_secret" required placeholder="development secret" style="width:100%;box-sizing:border-box;">
            </div>
            <div style="margin-bottom:16px;">
                <label>Redirect URIs <span style="color:#e74c3c;">*</span></label>
                <textarea name="redirect_uris" rows="3" required style="width:100%;box-sizing:border-box;font-family:monospace;font-size:12px;">["http://localhost:3006/callback"]</textarea>
                <small style="color:#95a5a6;">JSON array — must exactly match what the client sends.</small>
            </div>
            <button type="submit" class="btn-success">Register Client</button>
        </form>
    </div>
</div>
```

### 5.4 Unified Apps Grid — Badge + Dropdown Updates

**In the main apps grid card render (around line 241), change:**
```html
{% if app.schema_type == 'SAML' %}
<span class="badge" style="background:#e8f8f5; color:#117a65; border:1px solid #a3e4d7;">SAML</span>
{% else %}
<span class="badge" style="background:#eaf2f8; color:#2980b9;">{{ app.schema_type }}</span>
{% endif %}
```

**To:**
```html
{% if app.schema_type == 'SAML' %}
<span class="badge" style="background:#e8f8f5; color:#117a65; border:1px solid #a3e4d7;">SAML</span>
{% elif app.schema_type == 'OIDC' %}
<span class="badge" style="background:#f5eef8; color:#8e44ad; border:1px solid #d5b9d5;">OIDC</span>
{% else %}
<span class="badge" style="background:#eaf2f8; color:#2980b9;">{{ app.schema_type }}</span>
{% endif %}
```

**In both “Assign App to User” and “Remove App from User” dropdowns (around lines 414 and 449), change:**
```html
{% if app.schema_type == 'SAML' %}
{{ app.name }} (SAML)
{% else %}
{{ app.appId }} ({{ app.origin }})
{% endif %}
```

**To:**
```html
{% if app.schema_type == 'SAML' %}
{{ app.name }} (SAML)
{% elif app.schema_type == 'OIDC' %}
{{ app.name }} (OIDC)
{% else %}
{{ app.appId }} ({{ app.origin }})
{% endif %}
```

### 5.5 Dashboard (`PID/templates/dashboard.html`)

**Current card render (line 142):**
```html
{% if app.schema_type == 'SAML' %}
<span class="badge" ...>SAML</span>
{% else %}
<span class="badge" ...>{{ app.schema_type }}</span>
{% endif %}
```

**Updated to include OIDC badge (same styling as admin grid):**
```html
{% if app.schema_type == 'SAML' %}
<span class="badge" style="background:#e8f8f5; color:#117a65; border:1px solid #a3e4d7;">SAML</span>
{% elif app.schema_type == 'OIDC' %}
<span class="badge" style="background:#f5eef8; color:#8e44ad; border:1px solid #d5b9d5;">OIDC</span>
{% else %}
<span class="badge" style="background:#f8f9fa; color:#6c757d; border:1px solid #dee2e6;">{{ app.schema_type }}</span>
{% endif %}
```

The card title line already uses `{{ app.name or app.appId }}`, so no further change is needed there once `get_user_apps` enriches the name.

### 5.6 JavaScript Helpers

Add after the existing SAML helpers (after `closeSamlEdit`, before `</script>`):
```javascript
// ── OIDC client inline edit helpers ──────────────────────────────────────
function openOidcEdit(clientId, name, secret, redirectUris, enabled) {
    const form = document.getElementById('oidc-edit-form');
    form.action = `/admin/oidc-clients/${clientId}/update`;
    document.getElementById('edit-oidc-name').value = name;
    document.getElementById('edit-oidc-secret').value = secret;
    document.getElementById('edit-oidc-client-id').value = clientId;
    document.getElementById('edit-oidc-redirects').value = redirectUris;
    document.getElementById('edit-oidc-enabled').checked = !!enabled;
    const modal = document.getElementById('oidc-edit-modal');
    modal.style.display = 'block';
    modal.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeOidcEdit() {
    document.getElementById('oidc-edit-modal').style.display = 'none';
}
```

---

## 6. Runtime Authorization in OIDC Provider (`PID/oidc_provider.py`)

### 6.1 `/authorize` — add user assignment check

After the user is identified from session (or after `get_session_user`), **before generating the authorization code**, add:

```python
if not db.is_user_allowed_app(user_id, client_id):
    print(f"[OIDC] Access Denied: User {username} is not assigned to {client_id}")
    client_name = db.get_oidc_client(client_id)
    app_name = client_name.get("name") if client_name else client_id
    html = f"""<!DOCTYPE html>
<html>
<head>
    <title>Access Denied</title>
    <style>
        body {{ font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f7fa; color: #333; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }}
        .card {{ background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); text-align: center; max-width: 450px; border-top: 4px solid #e74c3c; }}
        h1 {{ color: #e74c3c; font-size: 24px; margin-top: 0; }}
        p {{ font-size: 15px; line-height: 1.6; color: #555; }}
        .btn {{ display: inline-block; margin-top: 20px; padding: 10px 20px; background-color: #3498db; color: white; text-decoration: none; border-radius: 4px; font-weight: 600; }}
        .btn:hover {{ background-color: #2980b9; }}
    </style>
</head>
<body>
    <div class="card">
        <h1>Access Denied</h1>
        <p>You are not authorized or assigned to access the application <strong>{app_name}</strong>.</p>
        <p>Please contact your administrator to request access.</p>
        <a href="/dashboard" class="btn">Return to Dashboard</a>
    </div>
</body>
</html>"""
    return HTMLResponse(content=html, status_code=403)
```

This is a character-for-character copy of the SAML Access Denied response in `app.py` lines 967–984, ensuring UI consistency.

### 6.2 `/oidc/resume` — add the same user assignment check

Same block, inserted after resolving `user` and `pending` and after parsing `client_id`, **before** generating the authorization code.

### 6.3 `/token` — optional hardening

The `/token` endpoint already looks up the client via `db.get_oidc_client(client_id)`. Since `get_oidc_client` only returns enabled rows, disabled clients will fail at token exchange anyway — which is fine. No change required here for MVP.

---

## 7. Summary of All Files to Modify

| File | What Changes |
|------|-------------|
| `PID/database.py` | 1. Fix `seed_oidc_client_if_missing` to also INSERT OR IGNORE into `apps`. 2. Add `get_all_oidc_clients()`. 3. Add `add_oidc_client()`. 4. Add `update_oidc_client()`. 5. Add `delete_oidc_client()`. 6. Update `delete_app()` cascade. 7. Update `get_all_apps()` enrichment. 8. Update `get_user_apps()` enrichment. |
| `PID/app.py` | 1. Pass `oidc_clients` to admin template context. 2. Add `POST /admin/oidc-clients`. 3. Add `POST /admin/oidc-clients/{id}/update`. 4. Add `POST /admin/oidc-clients/{id}/delete`. |
| `PID/templates/admin.html` | 1. Add OIDC stat card. 2. Add sidebar link. 3. Add full OIDC section (table, edit modal, add form). 4. Update apps-grid badge for OIDC. 5. Update dropdown selectors. 6. Add JS helpers. |
| `PID/templates/dashboard.html` | Add OIDC badge branch in the existing badge rendering block. |
| `PID/oidc_provider.py` | 1. Add `is_user_allowed_app` check + Access Denied HTML in `/authorize` (logged-in branch). 2. Add same check in `/oidc/resume`. |

Total new lines of Python: ~120 LOC across database.py and app.py.
Total new lines in oidc_provider.py: ~35 LOC.
Total template changes: ~200 LOC (HTML) + ~20 LOC (JS).

---

## 8. Execution Order (Recommended)

1. **Database layer first** (`database.py`) — seed fix + CRUD + enrichment. Verify with direct SQLite queries.
2. **Admin routes** (`app.py`) — wire the 3 new endpoints.
3. **Admin template** (`admin.html`) — stats, sidebar, section, JS.
4. **Dashboard template** (`dashboard.html`) — one badge branch add.
5. **OIDC provider auth checks** (`oidc_provider.py`) — copy SAML Access Denied pattern.
6. **Smoke test:**
   - Open `/admin` — OIDC Clients stat shows 1 (App F).
   - Edit App F client — redirects back, DB row updated.
   - Register new client — appears in dropdowns.
   - Delete new client — disappears from dropdowns and `oidc_clients`.
   - Delete App F from main apps grid — cascades cleanly.
   - Assign App F to testuser — dropdown shows friendly name.
   - Open App F while unassigned — sees Access Denied.
   - Assign, then open — works.
7. **Regression:** confirm SAML section, SAML admin routes, and Vault API still work unchanged.

---

## 9. Final State Statement

After this work, the admin panel unifies all three SSO paradigms:

```
Built a hybrid enterprise SSO admin platform with:
- Browser-extension credential replay for legacy apps (unified apps grid)
- SAML federated SSO with dedicated admin section and user assignments
- OIDC federated SSO with mirrored admin section, user assignments,
  runtime authorization enforcement, and dashboard rendering,
  all managed centrally through PID's unified admin panel.
```
