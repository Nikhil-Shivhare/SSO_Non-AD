const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = 3001;
const SALT_ROUNDS = 10;

// Middleware
app.use(express.urlencoded({ extended: true }));

// Session configuration
app.use(session({
    secret: 'app-a-legacy-secret-key-12345',
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
const loginPage = (error = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-A Login</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        form { margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #007bff; color: white; border: none; cursor: pointer; }
        button:hover { background: #0056b3; }
        .error { color: red; padding: 10px; background: #ffe6e6; border-radius: 5px; margin-bottom: 10px; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>App-A - Session-Based Legacy App</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    <h2>Login</h2>
    <form method="POST" action="/login">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Login</button>
    </form>
    <p>Don't have an account? <a href="/register">Register here</a></p>
</body>
</html>
`;

const registerPage = (error = '', success = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-A Register</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 400px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        form { margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #28a745; color: white; border: none; cursor: pointer; }
        button:hover { background: #1e7e34; }
        .error { color: red; padding: 10px; background: #ffe6e6; border-radius: 5px; margin-bottom: 10px; }
        .success { color: green; padding: 10px; background: #e6ffe6; border-radius: 5px; margin-bottom: 10px; }
        a { color: #007bff; }
    </style>
</head>
<body>
    <h1>App-A - Register</h1>
    ${error ? `<div class="error">${error}</div>` : ''}
    ${success ? `<div class="success">${success}</div>` : ''}
    <form method="POST" action="/register">
        <input type="text" name="username" placeholder="Username" required>
        <input type="password" name="password" placeholder="Password" required>
        <button type="submit">Register</button>
    </form>
    <p><a href="/login">Back to Login</a></p>
</body>
</html>
`;

const dashboardPage = (username) => `
<!DOCTYPE html>
<html>
<head>
    <title>App-A Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 600px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        .welcome { background: #e7f3ff; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .menu { background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .menu a { display: block; margin: 10px 0; color: #007bff; text-decoration: none; }
        .menu a:hover { text-decoration: underline; }
        .note { color: #666; font-size: 12px; margin-top: 20px; }
    </style>
</head>
<body>
    <h1>App-A Dashboard</h1>
    <div class="welcome">
        <strong>Welcome, ${username}!</strong>
        <p>You are logged in with an active session. Your session will expire in 30 minutes of inactivity.</p>
    </div>
    
    <div class="menu">
        <h3>Menu</h3>
        <a href="/change-password">Change Password</a>
        <a href="/logout">Logout</a>
    </div>
    
    <p class="note">Note: This app uses session-based authentication. You will remain logged in until you logout or your session expires.</p>
</body>
</html>
`;

const changePasswordPage = (username, error = '', success = '') => `
<!DOCTYPE html>
<html>
<head>
    <title>App-A Change Password</title>
    <style>
        body { font-family: Arial, sans-serif; max-width: 500px; margin: 50px auto; padding: 20px; }
        h1 { color: #333; }
        form { background: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
        input { display: block; margin: 10px 0; padding: 8px; width: 100%; box-sizing: border-box; }
        button { padding: 10px 20px; background: #ffc107; color: #333; border: none; cursor: pointer; }
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
    <p><a href="/dashboard">Back to Dashboard</a></p>
</body>
</html>
`;

// Routes

// GET /login - Show login form
app.get('/login', (req, res) => {
    if (req.session && req.session.userId) {
        return res.redirect('/dashboard');
    }
    res.send(loginPage());
});

// GET /register - Show registration form
app.get('/register', (req, res) => {
    res.send(registerPage());
});

// POST /login - Validate credentials and create session
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.send(loginPage('Username and password are required.'));
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
            
            // Create session
            req.session.userId = user.id;
            req.session.username = user.username;
            
            res.redirect('/dashboard');
        });
    });
});

// POST /register - Create new user
app.post('/register', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.send(registerPage('Username and password are required.'));
    }
    
    bcrypt.hash(password, SALT_ROUNDS, (err, hash) => {
        if (err) {
            return res.send(registerPage('Failed to hash password.'));
        }
        
        db.run('INSERT INTO users (username, password, display_name) VALUES (?, ?, ?)', 
            [username, hash, null], 
            (err) => {
                if (err) {
                    if (err.message.includes('UNIQUE constraint')) {
                        return res.send(registerPage('Username already exists.'));
                    }
                    return res.send(registerPage('Database error occurred.'));
                }
                res.send(registerPage('', 'Account created successfully! You can now login.'));
            }
        );
    });
});

// GET /dashboard - Show dashboard (requires session)
app.get('/dashboard', requireAuth, (req, res) => {
    res.send(dashboardPage(req.session.username));
});

// GET /change-password - Show password change form (requires session)
app.get('/change-password', requireAuth, (req, res) => {
    res.send(changePasswordPage(req.session.username));
});

// POST /change-password - Update password (requires session)
app.post('/change-password', requireAuth, (req, res) => {
    const { current_password, new_password } = req.body;
    const username = req.session.username;
    
    if (!current_password || !new_password) {
        return res.send(changePasswordPage(username, 'All fields are required.'));
    }
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err || !user) {
            return res.send(changePasswordPage(username, 'User not found.'));
        }
        
        bcrypt.compare(current_password, user.password, (err, match) => {
            if (err || !match) {
                return res.send(changePasswordPage(username, 'Current password is incorrect.'));
            }
            
            bcrypt.hash(new_password, SALT_ROUNDS, (err, hash) => {
                if (err) {
                    return res.send(changePasswordPage(username, 'Failed to hash new password.'));
                }
                
                db.run('UPDATE users SET password = ? WHERE username = ?', [hash, username], (err) => {
                    if (err) {
                        return res.send(changePasswordPage(username, 'Failed to update password.'));
                    }
                    res.send(changePasswordPage(username, '', 'Password changed successfully!'));
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
    console.log(`App-A running at http://localhost:${PORT}`);
    console.log('Session-based authentication with 30-minute timeout');
});
