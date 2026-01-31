# Project Commands - Quick Reference

## Architecture Overview

| Component        | Port | Purpose                          |
| ---------------- | ---- | -------------------------------- |
| Primary Identity | 4000 | Central SSO identity provider    |
| APP1 (App-A)     | 3001 | Legacy web app with login        |
| APP2 (App-B)     | 3002 | Legacy web app with login + CSRF |
| APP3 (App-C)     | 3003 | Legacy web app with login        |
| APP4 (App-D)     | 3004 | Legacy web app with login        |
| Launcher         | 3100 | App launcher portal              |
| Extension        | -    | Nikhil_Non_AD browser extension  |

---

## ⚡ Automated Scripts (Fastest Way)

### Start Everything

```bash
./start-all.sh
```

This starts: Primary Identity + APP1-4 + Launcher

### Stop Everything

```bash
./stop-all.sh
```

### View Logs

```bash
# View live logs
tail -f /tmp/primary-identity.log
tail -f /tmp/app1.log

# View all logs
ls /tmp/*.log
```

---

## 🚀 Quick Start (Manual)

```bash
# 1. Start Primary Identity
cd primary-identity
npm start

# 2. Start all legacy apps (in separate terminals)
cd APP1 && node app.js
cd APP2 && node app.js
cd APP3 && node app.js
cd APP4 && node app.js

# 3. Start launcher (optional)
cd launcher && node app.js

# 4. Install browser extension
# Open chrome://extensions
# Enable "Developer mode"
# Click "Load unpacked"
# Select: /path/to/sso-extension/
```

---

## 🛑 Stop All Services

```bash
# Kill all Node.js apps at once
pkill -f "node app.js"

# OR kill specific ports
lsof -ti:4000 | xargs kill -9  # Primary Identity
lsof -ti:3001 | xargs kill -9  # APP1
lsof -ti:3002 | xargs kill -9  # APP2
lsof -ti:3003 | xargs kill -9  # APP3
lsof -ti:3004 | xargs kill -9  # APP4
lsof -ti:3100 | xargs kill -9  # Launcher
```

---

## 🔄 Restart Services

### Primary Identity

```bash
lsof -ti:4000 | xargs kill -9 2>/dev/null
cd primary-identity && npm start
```

### Single App

```bash
# Example for APP1
lsof -ti:3001 | xargs kill -9 2>/dev/null
cd APP1 && node app.js
```

### All Apps (one command)

```bash
pkill -f "node app.js" 2>/dev/null
cd APP1 && node app.js &
cd APP2 && node app.js &
cd APP3 && node app.js &
cd APP4 && node app.js &
cd primary-identity && npm start
```

---

## 🔐 Login Credentials

### Primary Identity (http://localhost:4000/login)

| Username | Password     | Role  |
| -------- | ------------ | ----- |
| admin    | admin123     | Admin |
| testuser | TestPass123! | User  |

### Legacy Apps (auto-filled by extension after first login)

- Username: `testuser`
- Password: `TestPass123!` (or your custom password)

---

## 🧪 Testing the SSO Flow

### 1. Login to Primary Identity

```bash
# Visit: http://localhost:4000/login
# Login as: testuser / TestPass123!
```

### 2. Test Auto-Login (First Time)

```bash
# Visit: http://localhost:3001/login
# Extension prompts: "First-Time Login"
# Enter credentials manually
# Confirm save when prompted
```

### 3. Test Auto-Login (Subsequently)

```bash
# Visit: http://localhost:3002/login
# Extension shows prompt with 3 options:
#   1 = Auto-login (default)
#   2 = Type manually
#   3 = Update credentials
```

### 4. Test Password Change

```bash
# Visit: http://localhost:3002/change-password
# Enter: Current password + New password
# After success: Confirm to update vault
```

### 5. Test Logout Safety

```bash
# Visit: http://localhost:4000/logout
# Visit: http://localhost:3001/login
# Extension should NOT auto-fill (session ended)
```

---

## 📋 Extension Management

### Reload Extension

```bash
# 1. Go to chrome://extensions
# 2. Find "Nikhil_Non_AD"
# 3. Click "Reload" button
```

### View Extension Logs

```bash
# 1. Go to chrome://extensions
# 2. Click "service worker" under Nikhil_Non_AD
# 3. See background script logs
```

### View Content Script Logs

```bash
# 1. Open any legacy app page (e.g. localhost:3001)
# 2. Open DevTools (F12)
# 3. Go to Console tab
# 4. Filter by "[SSO]"
```

---

## 🐞 Debug Commands

### Check if ports are in use

```bash
lsof -i :4000  # Primary Identity
lsof -i :3001  # APP1
lsof -i :3002  # APP2
lsof -i :3003  # APP3
lsof -i :3004  # APP4
lsof -i :3100  # Launcher
```

### Test API endpoints

```bash
# Check Primary Identity session
curl http://localhost:4000/api/session/status

# Check legacy app health
curl http://localhost:3001/login
curl http://localhost:3002/login
curl http://localhost:3003/login
```

### View database (Primary Identity)

```bash
cd primary-identity
sqlite3 database.sqlite "SELECT * FROM users;"
sqlite3 database.sqlite "SELECT * FROM vault_credentials;"
```

---

## 📁 Project Structure

```
TEST3(new start)/
├── primary-identity/     # Port 4000 - SSO Identity Provider
├── APP1/                 # Port 3001 - Legacy App A
├── APP2/                 # Port 3002 - Legacy App B (with CSRF)
├── APP3/                 # Port 3003 - Legacy App C
├── APP4/                 # Port 3004 - Legacy App D
├── launcher/             # Port 3100 - App Launcher
├── sso-extension/        # Browser Extension (Nikhil_Non_AD)
└── COMMANDS.md          # This file
```

---

## 🔧 Troubleshooting

### Port already in use

```bash
# Find what's using the port
lsof -i :4000

# Kill it
lsof -ti:4000 | xargs kill -9
```

### Extension not working

```bash
# 1. Reload extension at chrome://extensions
# 2. Check service worker logs
# 3. Check console on app page
# 4. Verify Primary Identity is running (port 4000)
```

### Credentials not saving

```bash
# 1. Check if logged into Primary Identity
curl http://localhost:4000/api/session/status

# 2. Check extension logs for errors
# 3. Verify app is assigned to user in Primary Identity dashboard
```

### Password change not updating

```bash
# 1. Verify form has: current_password and new_password fields
# 2. Check extension detected the form (console logs)
# 3. After redirect, confirm the save prompt
# 4. Check vault:
sqlite3 primary-identity/database.sqlite "SELECT * FROM vault_credentials;"
```

---

## 📚 Documentation

- Primary Identity: `primary-identity/README.md`
- APP1-4: `APP1/README.md`, `APP2/README.md`, etc.
- Extension: `sso-extension/README.md`
- Launcher: `launcher/README.md`




