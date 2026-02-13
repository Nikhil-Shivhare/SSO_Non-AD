/**
 * Primary Identity Service - Database Module
 * 
 * SQLite database setup with seed data using sql.js (pure JavaScript).
 * 
 * SECURITY NOTES (PoC only):
 * - Passwords in vault_credentials are stored as PLAIN TEXT
 *   (Production: encrypt with AES-256-GCM)
 * - pluginToken is a random string
 *   (Production: use JWT or opaque token with proper signing)
 * - This component can be replaced with Keycloak in production
 */

const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vaultClient = require('./vaultClient');

const DB_PATH = path.join(__dirname, 'database.sqlite');
const SALT_ROUNDS = 10;

let db = null;

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

async function initDatabase() {
    const SQL = await initSqlJs();
    
    // Load existing database or create new one
    if (fs.existsSync(DB_PATH)) {
        const fileBuffer = fs.readFileSync(DB_PATH);
        db = new SQL.Database(fileBuffer);
        console.log('[DB] Loaded existing database');
    } else {
        db = new SQL.Database();
        console.log('[DB] Created new database');
    }

    // Create tables
    db.run(`
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

        -- User ↔ App mapping
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
    `);

    // Migrate existing databases: add vault_id column if missing
    try {
        db.run('ALTER TABLE users ADD COLUMN vault_id TEXT');
        console.log('[DB] Added vault_id column to existing users table');
        
        // Generate vault_id for existing users
        const existingUsers = queryAll('SELECT id FROM users WHERE vault_id IS NULL');
        existingUsers.forEach(user => {
            const vaultId = `vault_${user.id}`;
            run('UPDATE users SET vault_id = ? WHERE id = ?', [vaultId, user.id]);
        });
        if (existingUsers.length > 0) {
            console.log(`[DB] Generated vault_id for ${existingUsers.length} existing users`);
        }
    } catch (err) {
        // Column already exists, ignore
        if (!err.message.includes('duplicate column')) {
            console.error('[DB] Migration error:', err.message);
        }
    }
    
    // Guard: fix any users with NULL or empty vault_id (runs every startup)
    const usersWithoutVault = queryAll("SELECT id, username FROM users WHERE vault_id IS NULL OR vault_id = ''");
    if (usersWithoutVault.length > 0) {
        usersWithoutVault.forEach(user => {
            const vaultId = `vault_${user.id}`;
            db.run('UPDATE users SET vault_id = ? WHERE id = ?', [vaultId, user.id]);
            console.log(`[DB] Auto-assigned vault_id=${vaultId} for user ${user.username}`);
        });
    }
    
    // Seed if needed
    seedDatabase();
    saveDatabase();
    
    return db;
}

function saveDatabase() {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
}

// ============================================================================
// SEED DATA
// ============================================================================

function seedDatabase() {
    // Check if already seeded
    const result = db.exec('SELECT id FROM users WHERE username = ?', ['admin']);
    if (result.length > 0 && result[0].values.length > 0) {
        console.log('[DB] Database already seeded');
        return;
    }

    console.log('[DB] Seeding database...');

    // Default login schema (username + password)
    const defaultSchema = JSON.stringify({
        username: { selector: "input[name='username']", type: 'text' },
        password: { selector: "input[name='password']", type: 'password' }
    });
    
    // Role-based login schema (App-D)
    const roleSchema = JSON.stringify({
        username: { selector: "input[name='username']", type: 'text' },
        password: { selector: "input[name='password']", type: 'password' },
        role: { selector: "select[name='role']", type: 'select' }
    });

    // Seed apps with login schemas
    db.run('INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)', ['app_a', 'http://localhost:3001', defaultSchema]);
    db.run('INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)', ['app_b', 'http://localhost:3002', defaultSchema]);
    db.run('INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)', ['app_c', 'http://localhost:3003', defaultSchema]);
    db.run('INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)', ['app_d', 'http://localhost:3004', roleSchema]);
    console.log('[DB] Seeded 4 apps (including App-D with role schema)');

    // Seed users
    const adminHash = bcrypt.hashSync('admin123', SALT_ROUNDS);
    const userHash = bcrypt.hashSync('TestPass123!', SALT_ROUNDS);

    db.run('INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['admin', adminHash, 'admin']);
    db.run('INSERT OR IGNORE INTO users (username, password_hash, role) VALUES (?, ?, ?)', ['testuser', userHash, 'user']);
    
    // Set vault_id for seed users
    const adminUser = queryOne('SELECT id FROM users WHERE username = ?', ['admin']);
    const testUser = queryOne('SELECT id FROM users WHERE username = ?', ['testuser']);
    if (adminUser) run('UPDATE users SET vault_id = ? WHERE id = ?', [`vault_${adminUser.id}`, adminUser.id]);
    if (testUser) run('UPDATE users SET vault_id = ? WHERE id = ?', [`vault_${testUser.id}`, testUser.id]);
    
    console.log('[DB] Seeded 2 users: admin, testuser');

    // Get testuser ID for app assignment
    const userResult = db.exec('SELECT id, vault_id FROM users WHERE username = ?', ['testuser']);
    if (userResult.length > 0 && userResult[0].values.length > 0) {
        const testUserId = userResult[0].values[0][0];
        const testUserVaultId = userResult[0].values[0][1];
        
        // Get all app IDs
        const appsResult = db.exec('SELECT id, appId FROM apps');
        if (appsResult.length > 0) {
            // Assign apps to user
            appsResult[0].values.forEach(row => {
                const appId = row[0];
                db.run('INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)', [testUserId, appId]);
            });
            console.log('[DB] Assigned all apps to testuser');
            
            // Seed credentials via Vault Service (async, non-blocking)
            if (testUserVaultId) {
                appsResult[0].values.forEach(async row => {
                    const appIdString = row[1];
                    try {
                        await vaultClient.write(testUserVaultId, appIdString, {
                            username: 'testuser',
                            password: 'TestPass123!'
                        });
                        console.log(`[DB] Seeded vault credentials for testuser -> ${appIdString}`);
                    } catch (err) {
                        console.warn(`[DB] Failed to seed vault for ${appIdString}:`, err.message);
                    }
                });
            }
        }
    }
    
    saveDatabase();
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function queryOne(sql, params = []) {
    const result = db.exec(sql, params);
    if (result.length === 0 || result[0].values.length === 0) {
        return null;
    }
    const columns = result[0].columns;
    const values = result[0].values[0];
    const obj = {};
    columns.forEach((col, i) => obj[col] = values[i]);
    return obj;
}

function queryAll(sql, params = []) {
    const result = db.exec(sql, params);
    if (result.length === 0) {
        return [];
    }
    const columns = result[0].columns;
    return result[0].values.map(values => {
        const obj = {};
        columns.forEach((col, i) => obj[col] = values[i]);
        return obj;
    });
}

function run(sql, params = []) {
    db.run(sql, params);
    saveDatabase();
    return { lastInsertRowid: db.exec('SELECT last_insert_rowid()')[0].values[0][0] };
}

// ============================================================================
// USER FUNCTIONS
// ============================================================================

function findUserByUsername(username) {
    return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

function findUserById(id) {
    return queryOne('SELECT id, username, role, vault_id FROM users WHERE id = ?', [id]);
}

function getVaultId(userId) {
    const user = queryOne('SELECT vault_id FROM users WHERE id = ?', [userId]);
    return user ? user.vault_id : null;
}

function getAllUsers() {
    return queryAll('SELECT id, username, role FROM users');
}

function createUser(username, password, role) {
    const hash = bcrypt.hashSync(password, SALT_ROUNDS);
    try {
        // Insert user — get rowid IMMEDIATELY before saveDatabase() can reset it
        db.run('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
        const rowIdResult = db.exec('SELECT last_insert_rowid()');
        const userId = rowIdResult[0].values[0][0];
        
        // Set vault_id using the captured userId
        const vaultId = `vault_${userId}`;
        db.run('UPDATE users SET vault_id = ? WHERE id = ?', [vaultId, userId]);
        
        // Save once after both operations complete
        saveDatabase();
        console.log(`[DB] Created user ${username} with id=${userId}, vault_id=${vaultId}`);
        return { success: true, userId };
    } catch (err) {
        if (err.message.includes('UNIQUE constraint')) {
            return { success: false, error: 'Username already exists' };
        }
        throw err;
    }
}

async function deleteUser(id) {
    const user = findUserById(id);
    if (user && user.role === 'admin') {
        return { success: false, error: 'Cannot delete admin users' };
    }
    
    // Get vault_id and delete from Vault Service first
    const vaultId = getVaultId(id);
    if (vaultId) {
        const vaultResult = await vaultClient.deleteVault(vaultId);
        if (!vaultResult.success) {
            console.error(`[DB] Failed to delete vault for user ${id}:`, vaultResult.error);
            return { success: false, error: 'Failed to delete vault credentials' };
        }
        console.log(`[DB] Deleted vault credentials for user ${id}`);
    }
    
    // Cascade delete: remove all related data for this user
    run('DELETE FROM user_apps WHERE user_id = ?', [id]);
    run('DELETE FROM plugin_tokens WHERE user_id = ?', [id]);
    run('DELETE FROM users WHERE id = ?', [id]);
    
    console.log(`[DB] Deleted user ${id} and all related data`);
    return { success: true };
}

function verifyPassword(user, password) {
    return bcrypt.compareSync(password, user.password_hash);
}

// ============================================================================
// APP FUNCTIONS
// ============================================================================

function getAllApps() {
    return queryAll('SELECT * FROM apps');
}

function getAppByAppId(appId) {
    return queryOne('SELECT * FROM apps WHERE appId = ?', [appId]);
}

function getUserApps(userId) {
    return queryAll(`
        SELECT apps.* FROM apps
        INNER JOIN user_apps ON apps.id = user_apps.app_id
        WHERE user_apps.user_id = ?
    `, [userId]);
}

function assignAppToUser(userId, appId) {
    const app = queryOne('SELECT id FROM apps WHERE appId = ?', [appId]);
    if (!app) return { success: false, error: 'App not found' };
    
    try {
        run('INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)', [userId, app.id]);
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

function removeAppFromUser(userId, appId) {
    const app = queryOne('SELECT id FROM apps WHERE appId = ?', [appId]);
    if (!app) return { success: false, error: 'App not found' };
    
    run('DELETE FROM user_apps WHERE user_id = ? AND app_id = ?', [userId, app.id]);
    return { success: true };
}

function isUserAllowedApp(userId, appId) {
    const app = queryOne('SELECT id FROM apps WHERE appId = ?', [appId]);
    if (!app) return false;
    
    const mapping = queryOne('SELECT * FROM user_apps WHERE user_id = ? AND app_id = ?', [userId, app.id]);
    return !!mapping;
}

// ============================================================================
// PLUGIN TOKEN FUNCTIONS
// ============================================================================

function generatePluginToken(userId, scopes = ['vault:read', 'vault:write'], expiresInSeconds = 3600) {
    const token = 'ptk_' + crypto.randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    
    run('INSERT INTO plugin_tokens (token, user_id, scopes, expires_at) VALUES (?, ?, ?, ?)',
        [token, userId, JSON.stringify(scopes), expiresAt]);
    
    return { token, expiresIn: expiresInSeconds };
}

function introspectToken(token) {
    const row = queryOne('SELECT * FROM plugin_tokens WHERE token = ?', [token]);
    if (!row) {
        return { active: false, error: 'Token not found' };
    }
    
    const now = Math.floor(Date.now() / 1000);
    if (now > row.expires_at) {
        run('DELETE FROM plugin_tokens WHERE id = ?', [row.id]);
        return { active: false, error: 'Token expired' };
    }
    
    const user = findUserById(row.user_id);
    if (!user) {
        return { active: false, error: 'User not found' };
    }
    
    return {
        active: true,
        userId: row.user_id,
        username: user.username,
        scopes: JSON.parse(row.scopes)
    };
}

function revokeUserTokens(userId) {
    run('DELETE FROM plugin_tokens WHERE user_id = ?', [userId]);
}


function getAppWithSchema(appId) {
    const app = queryOne('SELECT * FROM apps WHERE appId = ?', [appId]);
    if (!app) return null;
    
    return {
        id: app.id,
        appId: app.appId,
        origin: app.origin,
        loginSchema: app.login_schema ? JSON.parse(app.login_schema) : null
    };
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = {
    initDatabase,
    
    // User functions
    findUserByUsername,
    findUserById,
    getAllUsers,
    createUser,
    deleteUser,
    verifyPassword,
    getVaultId,
    
    // App functions
    getAllApps,
    getAppByAppId,
    getUserApps,
    assignAppToUser,
    removeAppFromUser,
    isUserAllowedApp,
    
    // Token functions
    generatePluginToken,
    introspectToken,
    revokeUserTokens,
    
    // App schema function
    getAppWithSchema
};
