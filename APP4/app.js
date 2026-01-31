const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = 3004;
const SALT_ROUNDS = 10;

// Middleware
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
    secret: 'app-d-role-based-legacy-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 60 * 1000, // 30 minutes
        httpOnly: true
    }
}));

// Database setup
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL,
        display_name TEXT
    )`);
    
    // Seed users with different roles
    const seedUsers = [
        { username: 'admin1', password: 'AdminPass!', role: 'admin', display_name: 'Admin User' },
        { username: 'hr1', password: 'HrPass!', role: 'hr', display_name: 'HR User' },
        { username: 'intern1', password: 'InternPass!', role: 'intern', display_name: 'Intern User' },
        { username: 'ext1', password: 'ExtPass!', role: 'external', display_name: 'External User' }
    ];
    
    seedUsers.forEach(user => {
        db.get('SELECT * FROM users WHERE username = ?', [user.username], (err, row) => {
            if (!row) {
                bcrypt.hash(user.password, SALT_ROUNDS, (err, hash) => {
                    if (!err) {
                        db.run('INSERT INTO users (username, password, role, display_name) VALUES (?, ?, ?, ?)', 
                            [user.username, hash, user.role, user.display_name],
                            (err) => {
                                if (!err) {
                                    console.log(`Seed user created: ${user.username} / ${user.password} / role=${user.role}`);
                                }
                            }
                        );
                    }
                });
            }
        });
    });
});

// Middleware to check authentication
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
}

// Middleware to check role-based access
function requireRole(allowedRole) {
    return (req, res, next) => {
        if (!req.session || !req.session.userId) {
            return res.redirect('/login');
        }
        if (req.session.role !== allowedRole) {
            return res.status(403).send(`
                <!DOCTYPE html>
                <html>
                <head><title>Access Denied</title></ head>
                <body style="font-family: Arial; max-width: 500px; margin: 50px auto; padding: 20px;">
                    <h1>403 - Access Denied</h1>
                    <p>You do not have permission to access this page.</p>
                    <p>Your role: <strong>${req.session.role}</strong></p>
                    <p>Required role: <strong>${allowedRole}</strong></p>
                    <p><a href="/dashboard/${req.session.role}">Go to your dashboard</a></p>
                    <p><a href="/logout">Logout</a></p>
                </body>
                </html>
            `);
        }
        next();
    };
}

// HTML Templates

/**
 * CRITICAL: Role-Based Login
 * 
 * This login form requires THREE pieces of information:
 * 1. Username
 * 2. Password
 * 3. Role selection
 * 
 * WHY THIS BREAKS NAIVE SSO:
 * - Browser extensions that only replay username/password will FAIL
 * - The role must match the user's actual role in the database
 * - This tests whether SSO extensions can handle additional form fields
 */
const loginPage = (error = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-D Login</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .note { background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin-bottom: 20px; font-size: 13px; }
        form { background: #f8f9fa; padding: 20px; border-radius: 5px; }
        label { display: block; margin: 15px 0 5px 0; font-weight: bold; color: #555; }
        input, select { display: block; margin: 5px 0 15px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; width: 100%; }
        button:hover { background: #0056b3; }
        .error { color: red; padding: 10px; background: #ffe6e6; border-radius: 5px; margin-bottom: 15px; }
        .seed-info { background: #e7f3ff; padding: 10px; border-radius: 5px; margin-top: 20px; font-size: 12px; }
        .seed-info table { width: 100%; margin-top: 10px; border-collapse: collapse; }
        .seed-info th, .seed-info td { text-align: left; padding: 5px; border-bottom: 1px solid #ddd; }
    </style>
</head>
<body>
    <h1>App-D - Role-Based Legacy App</h1>
    
    <div class="note">
        <strong>⚠️ SSO Challenge:</strong> This login requires selecting the correct ROLE.
        Simply replaying username/password will FAIL if the role doesn't match.
    </div>
    
    ${error ? `<div class="error">${error}</div>` : ''}
    
    <form method="POST" action="/login">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" placeholder="Enter username" required>
        
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" placeholder="Enter password" required>
        
        <label for="role">Select Your Role:</label>
        <select id="role" name="role" required>
            <option value="">-- Select Role --</option>
            <option value="admin">Admin</option>
            <option value="hr">HR</option>
            <option value="intern">Intern</option>
            <option value="external">External</option>
        </select>
        
        <button type="submit">Login</button>
    </form>
    <p style="text-align: center; margin-top: 15px;"><a href="/register">Don't have an account? Register here</a></p>
    
    <div class="seed-info">
        <strong>Test Credentials:</strong>
        <table>
            <tr><th>Username</th><th>Password</th><th>Role</th></tr>
            <tr><td>admin1</td><td>AdminPass!</td><td>admin</td></tr>
            <tr><td>hr1</td><td>HrPass!</td><td>hr</td></tr>
            <tr><td>intern1</td><td>InternPass!</td><td>intern</td></tr>
            <tr><td>ext1</td><td>ExtPass!</td><td>external</td></tr>
        </table>
    </div>
</body>
</html>
`;

const dashboardPage = (username, role, displayName) => `
<!DOCTYPE html>
<html>
<head>
    <title>App-D Dashboard - ${role.toUpperCase()}</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .welcome { background: #e7f3ff; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .role-badge { display: inline-block; padding: 5px 15px; border-radius: 15px; font-size: 12px; font-weight: bold; color: white; text-transform: uppercase; }
        .role-badge.admin { background: #dc3545; }
        .role-badge.hr { background: #007bff; }
        .role-badge.intern { background: #28a745; }
        .role-badge.external { background: #ffc107; color: #333; }
        .menu { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .menu a { display: block; margin: 10px 0; color: #007bff; text-decoration: none; }
        .menu a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <h1>App-D Dashboard <span class="role-badge ${role}">${role}</span></h1>
    <div class="welcome">
        <strong>Welcome, ${displayName || username}!</strong>
        <p>You successfully logged in with the correct role.</p>
        <p>Your role: <strong>${role}</strong></p>
    </div>
    
    <div class="menu">
        <h3>Menu</h3>
        <a href="/change-password">Change Password</a>
        <a href="/logout">Logout</a>
    </div>
</body>
</html>
`;

const changePasswordPage = (username, error = '', success = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-D Change Password</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        form { background: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #ffc107; color: #333; border: none; cursor: pointer; width: 100%; }
        button:hover { background: #e0a800; }
        .error { color: red; padding: 10px; background: #ffe6e6; border-radius: 5px; margin-bottom: 10px; }
        .success { color: green; padding: 10px; background: #e6ffe6; border-radius: 5px; margin-bottom: 10px; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>Change Password</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    ${success ? `<div class="success">${success}</div>` : ''}
    <form method="POST" action="/change-password">
        <input type="password" name="current_password" placeholder="Current Password" required>
        <input type="password" name="new_password" placeholder="New Password" required>
        <button type="submit">Change Password</button>
    </form>
    <p><a href="/dashboard/${username}">Back to Dashboard</a></p>
</body>
</html>
`;

const registerPage = (error = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-D Register</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .note { background: #fff3cd; padding: 15px; border-left: 4px solid #ffc107; margin-bottom: 20px; font-size: 13px; }
        form { background: #f8f9fa; padding: 20px; border-radius: 5px; }
        label { display: block; margin: 15px 0 5px 0; font-weight: bold; color: #555; }
        input, select { display: block; margin: 5px 0 15px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #28a745; color: white; border: none; cursor: pointer; width: 100%; }
        button:hover { background: #218838; }
        .error { color: red; padding: 10px; background: #ffe6e6; border-radius: 5px; margin-bottom: 15px; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>App-D - Register New User</h1>
    
    <div class="note">
        <strong>⚠️ SSO Challenge:</strong> Registration also requires selecting a ROLE.
        The role you select will be saved to your account.
    </div>
    
    ${error ? `<div class="error">${error}</div>` : ''}
    
    <form method="POST" action="/register">
        <label for="username">Username:</label>
        <input type="text" id="username" name="username" placeholder="Choose a username" required>
        
        <label for="password">Password:</label>
        <input type="password" id="password" name="password" placeholder="Choose a password" required>
        
        <label for="role">Select Your Role:</label>
        <select id="role" name="role" required>
            <option value="">-- Select Role --</option>
            <option value="admin">Admin</option>
            <option value="hr">HR</option>
            <option value="intern">Intern</option>
            <option value="external">External</option>
        </select>
        
        <button type="submit">Register</button>
    </form>
    <p style="text-align: center; margin-top: 15px;"><a href="/login">Back to Login</a></p>
</body>
</html>
`;

// Routes

// GET /login - Show login form with role selector
app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect(`/dashboard/${req.session.role}`);
    }
    res.send(loginPage());
});

// POST /login - Validate credentials AND role
app.post('/login', (req, res) => {
    const { username, password, role } = req.body;
    
    if (!username || !password || !role) {
        return res.send(loginPage('All fields are required: username, password, and role.'));
    }
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            return res.send(loginPage('Database error occurred.'));
        }
        if (!user) {
            return res.send(loginPage('Invalid username or password.'));
        }
        
        bcrypt.compare(password, user.password, (err, match) => {
            if (err || !match) {
                return res.send(loginPage('Invalid username or password.'));
            }
            
            // CRITICAL: Verify role matches user's actual role in database
            if (user.role !== role) {
                return res.send(loginPage(`Invalid role selection. Your role is "${user.role}", but you selected "${role}".`));
            }
            
            // Create session with role
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.role = user.role;
            req.session.displayName = user.display_name;
            
            res.redirect(`/dashboard/${user.role}`);
        });
    });
});

// GET /register - Show registration form
app.get('/register', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect(`/dashboard/${req.session.role}`);
    }
    res.send(registerPage());
});

// POST /register - Create new user with role
app.post('/register', (req, res) => {
    const { username, password, role } = req.body;
    
    if (!username || !password || !role) {
        return res.send(registerPage('All fields are required: username, password, and role.'));
    }
    
    // Validate role is one of the allowed values
    const allowedRoles = ['admin', 'hr', 'intern', 'external'];
    if (!allowedRoles.includes(role)) {
        return res.send(registerPage('Invalid role selection.'));
    }
    
    bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
        if (err) {
            return res.send(registerPage('Failed to hash password.'));
        }
        
        db.run('INSERT INTO users (username, password, role, display_name) VALUES (?, ?, ?, ?)', 
            [username, hash, role, null], 
            (err) => {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.send(registerPage('Username already exists.'));
                    }
                    return res.send(registerPage('Database error occurred.'));
                }
                res.redirect('/login');
            }
        );
    });
});

// GET /dashboard/:role - Role-specific dashboards
app.get('/dashboard/admin', requireRole('admin'), (req, res) => {
    res.send(dashboardPage(req.session.username, 'admin', req.session.displayName));
});

app.get('/dashboard/hr', requireRole('hr'), (req, res) => {
    res.send(dashboardPage(req.session.username, 'hr', req.session.displayName));
});

app.get('/dashboard/intern', requireRole('intern'), (req, res) => {
    res.send(dashboardPage(req.session.username, 'intern', req.session.displayName));
});

app.get('/dashboard/external', requireRole('external'), (req, res) => {
    res.send(dashboardPage(req.session.username, 'external', req.session.displayName));
});

// GET /change-password - Show password change form (requires session)
app.get('/change-password', requireAuth, (req, res) => {
    res.send(changePasswordPage(req.session.role));
});

// POST /change-password - Update password (requires session)
app.post('/change-password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body;
    const username = req.session.username;
    
    if (!current_password || !new_password) {
        return res.send(changePasswordPage(req.session.role, 'All fields are required.'));
    }
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            return res.send(changePasswordPage(req.session.role, 'User not found.'));
        }
        
        bcrypt.compare(current_password, user.password, (err, match) => {
            if (err || !match) {
                return res.send(changePasswordPage(req.session.role, 'Current password is incorrect.'));
            }
            
            bcrypt.hash(new_password, SALT_ROUNDS, (err, hash) => {
                if (err) {
                    return res.send(changePasswordPage(req.session.role, 'Failed to hash new password.'));
                }
                
                db.run('UPDATE users SET password = ? WHERE username = ?', [hash, username], (err) => {
                    if (err) {
                        return res.send(changePasswordPage(req.session.role, 'Failed to update password.'));
                    }
                    res.send(changePasswordPage(req.session.role, '', 'Password changed successfully!'));
                });
            });
        });
    });
});

// GET /logout - Destroy session and redirect
app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Session destruction error:', err);
        }
        res.redirect('/login');
    });
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
    console.log(`App-D running at http://localhost:${PORT}`);
    console.log('Role-based login app - requires role selection to authenticate');
    console.log('This tests whether SSO extensions can handle non-standard form fields');
});
