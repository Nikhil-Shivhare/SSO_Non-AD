/**
 * Primary Identity Service - Main Application
 * 
 * Minimal PoC identity provider for SSO extension.
 * 
 * Port: 4000
 * Session Cookie: PID_SESSION (HTTP-Only)
 * 
 * SECURITY NOTES (PoC only):
 * - Passwords in vault are stored as PLAIN TEXT
 * - pluginToken is a random string (not JWT)
 * - This component can be replaced with Keycloak in production
 */

const express = require('express');
const session = require('express-session');
const db = require('./db');

const app = express();
const PORT = 4000;

// ============================================================================
// MIDDLEWARE
// ============================================================================

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Session configuration
app.use(session({
    name: 'PID_SESSION',
    secret: 'primary-identity-poc-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: false, // Set to true in production with HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// ============================================================================
// AUTH MIDDLEWARE
// ============================================================================

function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session && req.session.userId && req.session.role === 'admin') {
        return next();
    }
    res.status(403).send(htmlPage('Access Denied', '<h1>403 - Admin Access Required</h1><p><a href="/login">Login</a></p>'));
}

// Bearer token middleware for API routes
function requireBearerToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    
    const token = authHeader.substring(7);
    const introspection = db.introspectToken(token);
    
    if (!introspection.active) {
        return res.status(401).json({ error: introspection.error || 'Invalid token' });
    }
    
    req.tokenData = introspection;
    next();
}

// ============================================================================
// HTML TEMPLATES
// ============================================================================

function htmlPage(title, content) {
    return `<!DOCTYPE html>
<html>
<head>
    <title>${title} - Primary Identity</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; }
        h1 { color: #333; border-bottom: 2px solid #007bff; padding-bottom: 10px; }
        form { background: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0; }
        label { display: block; margin: 10px 0 5px; font-weight: bold; }
        input, select { padding: 8px; width: 100%; box-sizing: border-box; margin-bottom: 10px; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; margin: 5px 5px 5px 0; }
        button:hover { background: #0056b3; }
        button.danger { background: #dc3545; }
        button.danger:hover { background: #c82333; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; }
        th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
        th { background: #f8f9fa; }
        .message { padding: 10px; border-radius: 5px; margin: 10px 0; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .info { background: #cce5ff; color: #004085; }
        nav { background: #333; padding: 10px; margin: -20px -20px 20px -20px; }
        nav a { color: white; text-decoration: none; margin-right: 20px; }
        nav a:hover { text-decoration: underline; }
        .badge { display: inline-block; padding: 3px 8px; border-radius: 3px; font-size: 12px; }
        .badge-admin { background: #dc3545; color: white; }
        .badge-user { background: #28a745; color: white; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
    </style>
</head>
<body>
    ${content}
</body>
</html>`;
}

function navBar(role) {
    const adminLinks = role === 'admin' ? '<a href="/admin">Admin Panel</a>' : '';
    return `<nav>
        <a href="/dashboard">Dashboard</a>
        ${adminLinks}
        <a href="/logout">Logout</a>
    </nav>`;
}

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

// GET /login
app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect('/dashboard');
    }
    
    const html = htmlPage('Login', `
        <h1>Primary Identity - Login</h1>
        <p>This is the central identity provider for SSO PoC.</p>
        <form method="POST" action="/login">
            <label>Username:</label>
            <input type="text" name="username" required autofocus>
            <label>Password:</label>
            <input type="password" name="password" required>
            <button type="submit">Login</button>
        </form>
        <div class="info message">
            <strong>Demo Credentials:</strong><br>
            Admin: <code>admin</code> / <code>admin123</code><br>
            User: <code>testuser</code> / <code>TestPass123!</code>
        </div>
    `);
    res.send(html);
});

// POST /login
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.send(htmlPage('Login Error', `
            <h1>Login Failed</h1>
            <div class="error message">Username and password are required.</div>
            <p><a href="/login">Try again</a></p>
        `));
    }
    
    const user = db.findUserByUsername(username);
    if (!user || !db.verifyPassword(user, password)) {
        return res.send(htmlPage('Login Error', `
            <h1>Login Failed</h1>
            <div class="error message">Invalid username or password.</div>
            <p><a href="/login">Try again</a></p>
        `));
    }
    
    // Create session
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    
    console.log(`[AUTH] User logged in: ${user.username} (${user.role})`);
    res.redirect('/dashboard');
});

// GET /logout
app.get('/logout', (req, res) => {
    if (req.session.userId) {
        // Revoke all plugin tokens for this user
        db.revokeUserTokens(req.session.userId);
        console.log(`[AUTH] User logged out: ${req.session.username}`);
    }
    req.session.destroy();
    res.redirect('/login');
});

// ============================================================================
// DASHBOARD (USER)
// ============================================================================

app.get('/dashboard', requireAuth, (req, res) => {
    const user = db.findUserById(req.session.userId);
    const userApps = db.getUserApps(req.session.userId);
    
    const appRows = userApps.map(app => `
        <tr>
            <td>${app.appId}</td>
            <td>${app.origin}</td>
            <td><a href="${app.origin}/login" target="_blank">Open</a></td>
        </tr>
    `).join('') || '<tr><td colspan="3">No apps assigned</td></tr>';
    
    const html = htmlPage('Dashboard', `
        ${navBar(req.session.role)}
        <h1>Welcome, ${user.username}!</h1>
        <p>Role: <span class="badge badge-${user.role}">${user.role}</span></p>
        
        <h2>Your Assigned Apps</h2>
        <table>
            <tr><th>App ID</th><th>Origin</th><th>Action</th></tr>
            ${appRows}
        </table>
        
        <h2>SSO Extension Status</h2>
        <p>If you have the browser extension installed, it will automatically use your Primary Identity session to login to assigned apps.</p>
        <div class="info message">
            <strong>How it works:</strong>
            <ol>
                <li>Extension calls <code>POST /api/plugin/bootstrap</code> with your session cookie</li>
                <li>Server returns a <code>pluginToken</code> and list of allowed apps</li>
                <li>Extension uses token to fetch credentials from vault</li>
                <li>Extension auto-fills and submits login forms</li>
            </ol>
        </div>
    `);
    res.send(html);
});

// ============================================================================
// ADMIN PANEL
// ============================================================================

app.get('/admin', requireAdmin, (req, res) => {
    const users = db.getAllUsers();
    const apps = db.getAllApps();
    const message = req.query.message || '';
    const error = req.query.error || '';
    
    const userRows = users.map(user => {
        const userApps = db.getUserApps(user.id);
        const appList = userApps.map(a => a.appId).join(', ') || 'None';
        return `
            <tr>
                <td>${user.username}</td>
                <td><span class="badge badge-${user.role}">${user.role}</span></td>
                <td>${appList}</td>
                <td>
                    ${user.role !== 'admin' ? `
                        <form method="POST" action="/admin/users/${user.id}/delete" style="display:inline;">
                            <button type="submit" class="danger" onclick="return confirm('Delete this user?')">Delete</button>
                        </form>
                    ` : '(Admin)'}
                </td>
            </tr>
        `;
    }).join('');
    
    const appOptions = apps.map(app => `<option value="${app.appId}">${app.appId} (${app.origin})</option>`).join('');
    const userOptions = users.filter(u => u.role !== 'admin').map(u => `<option value="${u.id}">${u.username}</option>`).join('');
    
    const html = htmlPage('Admin Panel', `
        ${navBar(req.session.role)}
        <h1>Admin Panel</h1>
        
        ${message ? `<div class="success message">${message}</div>` : ''}
        ${error ? `<div class="error message">${error}</div>` : ''}
        
        <h2>Users</h2>
        <table>
            <tr><th>Username</th><th>Role</th><th>Assigned Apps</th><th>Actions</th></tr>
            ${userRows}
        </table>
        
        <h2>Create User</h2>
        <form method="POST" action="/admin/users">
            <label>Username:</label>
            <input type="text" name="username" required>
            <label>Password:</label>
            <input type="password" name="password" required>
            <label>Role:</label>
            <select name="role">
                <option value="user">User</option>
                <option value="admin">Admin</option>
            </select>
            <button type="submit">Create User</button>
        </form>
        
        <h2>Assign App to User</h2>
        <form method="POST" action="/admin/assign-app">
            <label>User:</label>
            <select name="userId" required>
                <option value="">-- Select User --</option>
                ${userOptions}
            </select>
            <label>App:</label>
            <select name="appId" required>
                <option value="">-- Select App --</option>
                ${appOptions}
            </select>
            <button type="submit">Assign App</button>
        </form>
        
        <h2>Remove App from User</h2>
        <form method="POST" action="/admin/remove-app">
            <label>User:</label>
            <select name="userId" required>
                <option value="">-- Select User --</option>
                ${userOptions}
            </select>
            <label>App:</label>
            <select name="appId" required>
                <option value="">-- Select App --</option>
                ${appOptions}
            </select>
            <button type="submit" class="danger">Remove App</button>
        </form>
    `);
    res.send(html);
});

// POST /admin/users - Create user
app.post('/admin/users', requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    const result = db.createUser(username, password, role || 'user');
    
    if (result.success) {
        console.log(`[ADMIN] Created user: ${username}`);
        res.redirect('/admin?message=User created successfully');
    } else {
        res.redirect(`/admin?error=${encodeURIComponent(result.error)}`);
    }
});

// POST /admin/users/:id/delete - Delete user
app.post('/admin/users/:id/delete', requireAdmin, (req, res) => {
    const result = db.deleteUser(parseInt(req.params.id));
    
    if (result.success) {
        console.log(`[ADMIN] Deleted user ID: ${req.params.id}`);
        res.redirect('/admin?message=User deleted');
    } else {
        res.redirect(`/admin?error=${encodeURIComponent(result.error)}`);
    }
});

// POST /admin/assign-app - Assign app to user
app.post('/admin/assign-app', requireAdmin, (req, res) => {
    const { userId, appId } = req.body;
    const result = db.assignAppToUser(parseInt(userId), appId);
    
    if (result.success) {
        console.log(`[ADMIN] Assigned ${appId} to user ${userId}`);
        res.redirect('/admin?message=App assigned');
    } else {
        res.redirect(`/admin?error=${encodeURIComponent(result.error)}`);
    }
});

// POST /admin/remove-app - Remove app from user
app.post('/admin/remove-app', requireAdmin, (req, res) => {
    const { userId, appId } = req.body;
    const result = db.removeAppFromUser(parseInt(userId), appId);
    
    if (result.success) {
        console.log(`[ADMIN] Removed ${appId} from user ${userId}`);
        res.redirect('/admin?message=App removed');
    } else {
        res.redirect(`/admin?error=${encodeURIComponent(result.error)}`);
    }
});

// ============================================================================
// API: SESSION STATUS
// ============================================================================

app.get('/api/session/status', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({
            authenticated: true,
            userId: req.session.userId,
            username: req.session.username,
            role: req.session.role
        });
    } else {
        res.status(401).json({ authenticated: false });
    }
});

// ============================================================================
// API: EXTENSION BOOTSTRAP
// ============================================================================

app.post('/api/plugin/bootstrap', requireAuth, (req, res) => {
    const userId = req.session.userId;
    const username = req.session.username;
    
    // Generate plugin token
    const { token, expiresIn } = db.generatePluginToken(userId);
    
    // Get user's allowed apps with login schemas
    const userApps = db.getUserApps(userId);
    const apps = userApps.map(app => {
        const appWithSchema = db.getAppWithSchema(app.appId);
        return {
            appId: app.appId,
            origin: app.origin,
            loginSchema: appWithSchema ? appWithSchema.loginSchema : null
        };
    });
    
    console.log(`[BOOTSTRAP] Generated pluginToken for ${username}, apps: ${apps.map(a => a.appId).join(', ')}`);
    
    res.json({
        pluginToken: token,
        expiresIn: expiresIn,
        userId: userId,
        username: username,
        apps: apps
    });
});

// ============================================================================
// API: TOKEN INTROSPECTION
// ============================================================================

app.post('/api/token/introspect', (req, res) => {
    const { pluginToken } = req.body;
    
    if (!pluginToken) {
        return res.status(400).json({ active: false, error: 'pluginToken is required' });
    }
    
    const result = db.introspectToken(pluginToken);
    res.json(result);
});

// ============================================================================
// API: VAULT CREDENTIALS
// ============================================================================

// GET /api/vault/credentials?appId=app_a
app.get('/api/vault/credentials', requireBearerToken, (req, res) => {
    const { appId } = req.query;
    const userId = req.tokenData.userId;
    
    if (!appId) {
        return res.status(400).json({ error: 'appId query parameter is required' });
    }
    
    // Check if user is allowed to access this app
    if (!db.isUserAllowedApp(userId, appId)) {
        return res.status(403).json({ error: 'User not authorized for this app' });
    }
    
    // Check scope
    if (!req.tokenData.scopes.includes('vault:read')) {
        return res.status(403).json({ error: 'Token does not have vault:read scope' });
    }
    
    // Get credentials
    const credentials = db.getVaultCredentials(userId, appId);
    
    if (!credentials) {
        return res.status(404).json({ error: 'No credentials found for this app' });
    }
    
    console.log(`[VAULT] Returned credentials for ${req.tokenData.username} -> ${appId}`);
    
    // Return extensible fields format
    res.json({
        appId: appId,
        fields: credentials.fields
    });
});

// POST /api/vault/credentials
app.post('/api/vault/credentials', requireBearerToken, (req, res) => {
    const { appId, fields } = req.body;
    const userId = req.tokenData.userId;
    
    // Support both old format (username, password) and new format (fields)
    let credentialFields = fields;
    if (!fields && req.body.username && req.body.password) {
        // Backward compatibility: convert old format
        credentialFields = {
            username: req.body.username,
            password: req.body.password
        };
    }
    
    if (!appId || !credentialFields || !credentialFields.username || !credentialFields.password) {
        return res.status(400).json({ error: 'appId and fields (with username, password) are required' });
    }
    
    // Check if user is allowed to access this app
    if (!db.isUserAllowedApp(userId, appId)) {
        return res.status(403).json({ error: 'User not authorized for this app' });
    }
    
    // Check scope
    if (!req.tokenData.scopes.includes('vault:write')) {
        return res.status(403).json({ error: 'Token does not have vault:write scope' });
    }
    
    // Save credentials
    const result = db.saveVaultCredentials(userId, appId, credentialFields);
    
    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }
    
    console.log(`[VAULT] Saved credentials for ${req.tokenData.username} -> ${appId}`);
    
    res.json({ success: true, message: 'Credentials saved' });
});

// PUT /api/vault/password - Update password only (for password change)
app.put('/api/vault/password', requireBearerToken, (req, res) => {
    const { appId, newPassword } = req.body;
    const userId = req.tokenData.userId;
    
    if (!appId || !newPassword) {
        return res.status(400).json({ error: 'appId and newPassword are required' });
    }
    
    // Check if user is allowed to access this app
    if (!db.isUserAllowedApp(userId, appId)) {
        return res.status(403).json({ error: 'User not authorized for this app' });
    }
    
    // Check scope
    if (!req.tokenData.scopes.includes('vault:write')) {
        return res.status(403).json({ error: 'Token does not have vault:write scope' });
    }
    
    // Use new updateVaultPassword function (preserves other fields)
    const result = db.updateVaultPassword(userId, appId, newPassword);
    
    if (!result.success) {
        return res.status(400).json({ error: result.error });
    }
    
    console.log(`[VAULT] Updated password for ${req.tokenData.username} -> ${appId}`);
    
    res.json({ success: true, message: 'Password updated' });
});

// ============================================================================
// ROOT REDIRECT
// ============================================================================

app.get('/', (req, res) => {
    res.redirect('/login');
});

// ============================================================================
// START SERVER (with async DB init)
// ============================================================================

async function startServer() {
    try {
        await db.initDatabase();
        
        app.listen(PORT, '127.0.0.1', () => {
            console.log('========================================');
            console.log('Primary Identity Service');
            console.log('========================================');
            console.log(`Running at: http://localhost:${PORT}`);
            console.log(`Login page: http://localhost:${PORT}/login`);
            console.log('');
            console.log('Demo credentials:');
            console.log('  Admin: admin / admin123');
            console.log('  User:  testuser / TestPass123!');
            console.log('========================================');
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

startServer();
