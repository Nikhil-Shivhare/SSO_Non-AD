/**
 * add-picoctf.js
 *
 * One-time migration script to register picoCTF as a real external app in PID.
 * Safe to run multiple times — uses INSERT OR IGNORE, so existing data is untouched.
 *
 * Run with: node add-picoctf.js
 * Run from: primary-identity/ directory
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'database.sqlite');

async function main() {
    if (!fs.existsSync(DB_PATH)) {
        console.error('[ERROR] database.sqlite not found. Make sure PID has been started at least once.');
        process.exit(1);
    }

    const SQL = await initSqlJs();
    const fileBuffer = fs.readFileSync(DB_PATH);
    const db = new SQL.Database(fileBuffer);

    // picoCTF login_schema — selectors confirmed from DevTools inspection
    const picoctfSchema = JSON.stringify({
        username: { selector: "#username", type: "text" },
        password: { selector: "#password", type: "password" }
    });

    // 1. Insert the app (safe, won't duplicate)
    db.run(
        'INSERT OR IGNORE INTO apps (appId, origin, login_schema) VALUES (?, ?, ?)',
        ['picoctf', 'https://play.picoctf.org', picoctfSchema]
    );
    console.log('[OK] App "picoctf" registered (or already existed).');

    // 2. Show all apps
    const appsResult = db.exec('SELECT id, appId, origin FROM apps');
    console.log('\nAll registered apps:');
    if (appsResult.length > 0) {
        appsResult[0].values.forEach(([id, appId, origin]) => {
            console.log(`  [${id}] ${appId} -> ${origin}`);
        });
    }

    // 3. Show all users (to help with assignment)
    const usersResult = db.exec('SELECT id, username, role FROM users');
    console.log('\nAll users:');
    let users = [];
    if (usersResult.length > 0) {
        usersResult[0].values.forEach(([id, username, role]) => {
            console.log(`  [${id}] ${username} (${role})`);
            users.push({ id, username, role });
        });
    }

    // 4. Get picoctf app id
    const appRow = db.exec("SELECT id FROM apps WHERE appId = 'picoctf'");
    if (!appRow.length || !appRow[0].values.length) {
        console.error('[ERROR] Failed to find picoctf app after insert.');
        process.exit(1);
    }
    const picoctfAppId = appRow[0].values[0][0];

    // 5. Assign picoctf to ALL non-admin users (safe, won't duplicate)
    let assignedCount = 0;
    users.forEach(({ id, username, role }) => {
        db.run(
            'INSERT OR IGNORE INTO user_apps (user_id, app_id) VALUES (?, ?)',
            [id, picoctfAppId]
        );
        console.log(`[OK] Assigned "picoctf" to user "${username}"`);
        assignedCount++;
    });

    // 6. Save
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
    console.log(`\n[DONE] Database saved. Assigned picoctf to ${assignedCount} user(s).`);
    console.log('[INFO] Restart PID for changes to take effect.');
}

main().catch(err => {
    console.error('[FATAL]', err.message);
    process.exit(1);
});
