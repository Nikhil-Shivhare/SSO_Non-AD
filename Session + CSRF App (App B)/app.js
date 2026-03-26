const express = require('express');
const session = require('express-session');
const csrf = require('csurf');
const cookieParser = require('cookie-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = 3002;
const SALT_ROUNDS = 10;

// Middleware
app.use(express.urlencoded({ extended: true }));
// Serve shared UI assets
app.use('/shared', express.static(path.join(__dirname, '../shared-ui')));
app.use(cookieParser()); // Required for CSRF

// Session configuration
app.use(session({
    secret: 'app-b-legacy-secret-key-67890',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 60 * 1000, // 30 minutes
        httpOnly: true
    }
}));

// CSRF Protection
// The csurf middleware generates a CSRF token that must be included in all state-changing requests.
// This protects against Cross-Site Request Forgery attacks by ensuring requests originate from our forms.
const csrfProtection = csrf({ cookie: false }); // Using session instead of cookies for token storage

// Database setup
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'));

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT
    )`);
});

// Middleware to check authentication
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        next();
    } else {
        res.redirect('/login');
    }
}

// HTML Templates
const loginPage = (csrfToken, error = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-B Login</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/shared/theme.css">
    <script src="/shared/app-features.js" defer></script>
</head>
<body>
    <h1>App-B - Session + CSRF Legacy App</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <h2>Login</h2>
    <form method="POST" action="/login">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
    </form>
    <p>Don't have an account? <a href="/register">Register here</a></p>
    <p class="csrf-note">This form is protected by CSRF token validation.</p>
</body>
</html>
`;

const registerPage = (csrfToken, error = '', success = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-B Register</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/shared/theme.css">
    <script src="/shared/app-features.js" defer></script>
</head>
<body>
    <h1>App-B - Register</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    ${success ? `<div class="success">${success}</div>` : ''}
    <form method="POST" action="/register">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Register</button>
    </form>
    <p><a href="/login">Back to Login</a></p>
    <p class="csrf-note">This form is protected by CSRF token validation.</p>
</body>
</html>
`;

const dashboardPage = (username) => `
<!DOCTYPE html>
<html>
<head>
    <title>App-B Dashboard</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/shared/theme.css">
    <script src="/shared/app-features.js" defer></script>
</head>
<body>
    <h1>App-B Dashboard</h1>
    <div class="welcome">
        <strong>Welcome, ${username}!</strong>
        <p>You are logged in with an active session. Your session will expire in 30 minutes of inactivity.</p>
        <span class="security-badge">🛡️ CSRF Protected</span>
    </div>
    
    <div class="menu">
        <h3>Menu</h3>
        <a href="/change-password">Change Password</a>
        <a href="/logout">Logout</a>
    </div>
    
    <p class="note">Note: This app uses session-based authentication with CSRF protection on all state-changing operations.</p>
</body>
</html>
`;

const changePasswordPage = (csrfToken, username, error = '', success = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-B Change Password</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="/shared/theme.css">
    <script src="/shared/app-features.js" defer></script>
</head>
<body>
    <h1>Change Password</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    ${success ? `<div class="success">${success}</div>` : ''}
    <form method="POST" action="/change-password">
        <input type="hidden" name="_csrf" value="${csrfToken}">
        <input type="password" name="current_password" placeholder="Current Password" required>
        <input type="password" name="new_password" placeholder="New Password" required>
        <button type="submit">Change Password</button>
    </form>
    <p><a href="/dashboard">Back to Dashboard</a></p>
    <p class="csrf-note">This form is protected by CSRF token validation.</p>
</body>
</html>
`;

// Routes

// GET /login - Show login form with CSRF token
app.get('/login', csrfProtection, (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.send(loginPage(req.csrfToken()));
});

// GET /register - Show registration form with CSRF token
app.get('/register', csrfProtection, (req, res) => {
    res.send(registerPage(req.csrfToken()));
});

// POST /login - Validate CSRF token and credentials, create session
app.post('/login', csrfProtection, (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.send(loginPage(req.csrfToken(), 'Username and password are required.'));
    }
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            return res.send(loginPage(req.csrfToken(), 'Database error occurred.'));
        }
        if (!user) {
            return res.send(loginPage(req.csrfToken(), 'Invalid username or password.'));
        }
        
        bcrypt.compare(password, user.password, (err, match) => {
            if (err || !match) {
                return res.send(loginPage(req.csrfToken(), 'Invalid username or password.'));
            }
            
            // Create session
            req.session.userId = user.id;
            req.session.username = user.username;
            
            res.redirect('/dashboard');
        });
    });
});

// POST /register - Validate CSRF token and create new user
app.post('/register', csrfProtection, (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.send(registerPage(req.csrfToken(), 'Username and password are required.'));
    }
    
    bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
        if (err) {
            return res.send(registerPage(req.csrfToken(), 'Failed to hash password.'));
        }
        
        db.run('INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)', 
            [username, hash, null], 
            (err) => {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.send(registerPage(req.csrfToken(), 'Username already exists.'));
                    }
                    return res.send(registerPage(req.csrfToken(), 'Database error occurred.'));
                }
                res.send(registerPage(req.csrfToken(), '', 'Account created successfully! You can now login.'));
            }
        );
    });
});

// GET /dashboard - Show dashboard (requires session)
app.get('/dashboard', requireAuth, (req, res) => {
    res.send(dashboardPage(req.session.username));
});

// GET /change-password - Show password change form with CSRF token (requires session)
app.get('/change-password', requireAuth, csrfProtection, (req, res) => {
    res.send(changePasswordPage(req.csrfToken(), req.session.username));
});

// POST /change-password - Validate CSRF token and update password (requires session)
app.post('/change-password', requireAuth, csrfProtection, (req, res) => {
    const { current_password, new_password } = req.body;
    const username = req.session.username;
    
    if (!current_password || !new_password) {
        return res.send(changePasswordPage(req.csrfToken(), username, 'All fields are required.'));
    }
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            return res.send(changePasswordPage(req.csrfToken(), username, 'User not found.'));
        }
        
        bcrypt.compare(current_password, user.password, (err, match) => {
            if (err || !match) {
                return res.send(changePasswordPage(req.csrfToken(), username, 'Current password is incorrect.'));
            }
            
            bcrypt.hash(new_password, SALT_ROUNDS, (err, hash) => {
                if (err) {
                    return res.send(changePasswordPage(req.csrfToken(), username, 'Failed to hash new password.'));
                }
                
                db.run('UPDATE users SET password = ? WHERE username = ?', [hash, username], (err) => {
                    if (err) {
                        return res.send(changePasswordPage(req.csrfToken(), username, 'Failed to update password.'));
                    }
                    res.send(changePasswordPage(req.csrfToken(), username, '', 'Password changed successfully!'));
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

// CSRF Error Handler
app.use((err, req, res, next) => {
    if (err.code === 'EBADCSRFTOKEN') {
        // CSRF token validation failed
        res.status(403).send(`
            <!DOCTYPE html>
            <html>
            <head><title>CSRF Error</title></head>
            <body style="font-family: Arial; max-width: 500px; margin: 50px auto; padding: 20px;">
                <h1>Invalid CSRF Token</h1>
                <p>The form submission was rejected due to invalid CSRF token. This could happen if:</p>
                <ul>
                    <li>Your session expired</li>
                    <li>You submitted the form from an external source</li>
                    <li>The page was cached</li>
                </ul>
                <p><a href="/login">Return to Login</a></p>
            </body>
            </html>
        `);
    } else {
        next(err);
    }
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
    console.log(`App-B running at http://localhost:${PORT}`);
    console.log('Session-based authentication with CSRF protection');
});
