const express = require('express');
const path = require('path');

const app = express();
const PORT = 3100;

// Serve static HTML
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Non-AD Apps Launcher</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: #f5f5f5;
        }
        h1 {
            color: #333;
            text-align: center;
            margin-bottom: 40px;
        }
        .app-list {
            background: white;
            padding: 30px;
            border-radius: 8px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .app-item {
            margin: 20px 0;
            padding: 15px;
            border-left: 4px solid #007bff;
            background: #f8f9fa;
        }
        .app-item h3 {
            margin: 0 0 5px 0;
            color: #007bff;
        }
        .app-item p {
            margin: 5px 0;
            color: #666;
            font-size: 14px;
        }
        .app-item a {
            display: inline-block;
            margin-top: 10px;
            padding: 8px 16px;
            background: #007bff;
            color: white;
            text-decoration: none;
            border-radius: 4px;
        }
        .app-item a:hover {
            background: #0056b3;
        }
        .note {
            margin-top: 30px;
            padding: 15px;
            background: #fff3cd;
            border-left: 4px solid #ffc107;
            font-size: 13px;
            color: #856404;
        }
    </style>
</head>
<body>
    <h1>Non-AD Apps Launcher</h1>
    
    <div class="app-list">
        <div class="app-item">
            <h3>App A — Session-based app</h3>
            <p>Traditional session-based authentication with 30-minute timeout</p>
            <a href="http://localhost:3001/login" target="_blank">Launch App A</a>
        </div>
        
        <div class="app-item">
            <h3>App B — Session + CSRF app</h3>
            <p>Session-based authentication with CSRF protection</p>
            <a href="http://localhost:3002/login" target="_blank">Launch App B</a>
        </div>
        
        <div class="app-item">
            <h3>App C — Stateless app (no session)</h3>
            <p>Stateless application requiring login on every page refresh</p>
            <a href="http://localhost:3003/login" target="_blank">Launch App C</a>
        </div>
        
        <div class="app-item">
            <h3>App D &mdash; Role-based login app</h3>
            <p>Requires role selection during login - breaks naive SSO credential replay</p>
            <a href="http://localhost:3004/login" target="_blank">Launch App D</a>
        </div>

        <div class="app-item" style="border-left-color:#1e3a5f;">
            <h3>App E &mdash; SAML Federated SSO &#128272;</h3>
            <p>
                SAML 2.0 Service Provider &mdash; delegates authentication to the PID Identity Provider.<br>
                <strong>No username/password in App E</strong>: login is federated via signed SAML assertion.
            </p>
            <a href="http://localhost:3005/login" target="_blank" style="background:#1e3a5f;">Launch App E (SAML)</a>
            <a href="http://localhost:3005/saml/metadata" target="_blank" style="background:#555; margin-left:6px;">SP Metadata</a>
        </div>
    </div>

    <div class="note">
        <strong>Credential Replay SSO (Apps A-D):</strong> Chrome extension + PID vault replays credentials to legacy apps that cannot be modified.<br><br>
        <strong>SAML Federated SSO (App E):</strong> PID acts as SAML 2.0 Identity Provider. App E is a Service Provider that trusts signed PID assertions &mdash; no password prompt in App E after PID login.
    </div>
</body>
</html>
    `);
});

// Start server
app.listen(PORT, '127.0.0.1', () => {
    console.log(`App Launcher running at http://localhost:${PORT}`);
    console.log('This is a navigation UI only - no authentication or backend logic');
});
