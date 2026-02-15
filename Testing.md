# Testing Guide

This document provides comprehensive test cases for validating the PID-Vault separation architecture.

---

## 1. Starting Services

### Start All Services

```bash
# 1. Start Vault Service (Postgres + Vault instances + nginx)
cd vault-service && docker-compose up -d && cd ..

# 2. Start Primary Identity Service
cd primary-identity && npm start
```

### Stop All Services

```bash
# 1. Stop PID
pkill -f "node.*primary-identity"

# 2. Stop Vault Service
cd vault-service && docker-compose down && cd ..
```

---

## 2. Health Checks

### Check Vault Health

```bash
curl -s http://localhost:5000/health | jq .
```

**Expected Response:**

```json
{
  "status": "ok",
  "service": "vault-service",
  "instance": "vault",
  "timestamp": "2026-02-15T12:00:00.000Z"
}
```

### Check PID Health

```bash
curl -s http://localhost:4000/ | head -c 100
```

**Expected:** HTML login page response

### Check Docker Containers

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

### kill all Docker Containers

```bash
docker kill $(docker ps -q)
```

---

## 3. PID Database Tests

### Access PID Database

```bash
cd primary-identity
sqlite3 database.sqlite
```

### Test Cases: PID Database

| Test Case                 | Command                                                                                                                       | Expected Result                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| List tables               | `.tables`                                                                                                                     | `apps plugin_tokens user_apps users`        |
| Check users with vault_id | `SELECT id, username, vault_id FROM users;`                                                                                   | Shows all users with their vault_id         |
| Check user-app mapping    | `SELECT u.username, u.vault_id, a.appId FROM users u JOIN user_apps ua ON u.id = ua.user_id JOIN apps a ON a.id = ua.app_id;` | Shows user-app assignments                  |
| Check apps                | `SELECT * FROM apps;`                                                                                                         | Shows all registered apps with login_schema |
| Check plugin_tokens       | `SELECT * FROM plugin_tokens;`                                                                                                | Shows active tokens                         |
| Invalid table             | `SELECT * FROM user;`                                                                                                         | `Parse error: no such table: user`          |

---

## 4. Vault Database Tests

### Access Vault Database

```bash
# Primary (read-write)
docker exec -it postgres-primary psql -U vault_user -d vault_db
# Password: vault_secret
```

### Test Cases: Vault Database

| Test Case         | Command                                                     | Expected Result               |
| ----------------- | ----------------------------------------------------------- | ----------------------------- |
| List tables       | `\dt`                                                       | `audit_log vault_credentials` |
| View credentials  | `SELECT vault_id, app_id, fields FROM vault_credentials;`   | Shows stored credentials      |
| Count credentials | `SELECT COUNT(*) FROM vault_credentials;`                   | Number of stored credentials  |
| View audit log    | `SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;` | Shows access history          |
| Check replica     | `SELECT vault_id, app_id, fields FROM vault_credentials;`   | Should match primary          |

### Query from Command Line

```bash
# All credentials (primary)
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT vault_id, app_id, fields FROM vault_credentials;"

# On replica (read-only)
PGPASSWORD=vault_secret psql -h localhost -p 5434 -U vault_user -d vault_db \
  -c "SELECT vault_id, app_id, fields FROM vault_credentials;"
```

---

## 5. API Tests

### Test Vault Internal APIs

| Test Case                   | Command                                                                                                                                                                                              | Expected Result                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Write credentials           | `curl -s -X POST http://localhost:5000/internal/vault/write -H "Content-Type: application/json" -d '{"vaultId":"test_vault","appId":"test_app","fields":{"username":"myuser","password":"mypass"}}'` | `{"success":true}`                  |
| Read credentials            | `curl -s -X POST http://localhost:5000/internal/vault/read -H "Content-Type: application/json" -d '{"vaultId":"test_vault","appId":"test_app"}'`                                                     | Returns fields JSON                 |
| Update password             | `curl -s -X POST http://localhost:5000/internal/vault/update-password -H "Content-Type: application/json" -d '{"vaultId":"test_vault","appId":"test_app","newPassword":"newpass"}'`                  | `{"success":true}`                  |
| Delete credential           | `curl -s -X POST http://localhost:5000/internal/vault/delete -H "Content-Type: application/json" -d '{"vaultId":"test_vault","appId":"test_app"}'`                                                   | `{"success":true}`                  |
| Delete all user credentials | `curl -s -X POST http://localhost:5000/internal/vault/delete-vault -H "Content-Type: application/json" -d '{"vaultId":"test_vault"}'`                                                                | `{"success":true,"deletedCount":N}` |
| Read non-existent           | `curl -s -X POST http://localhost:5000/internal/vault/read -H "Content-Type: application/json" -d '{"vaultId":"nonexistent","appId":"nonexistent"}'`                                                 | `{"error":"Credentials not found"}` |

### Test PID APIs

| Test Case                    | Command                                                                                              | Expected Result              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| Session status (logged out)  | `curl -s http://localhost:4000/api/session/status`                                                   | `{"authenticated":false}`    |
| Login                        | `curl -s -X POST http://localhost:4000/login -d "username=admin&password=admin123" -c cookies.txt`   | Redirect or success          |
| Bootstrap                    | `curl -s -X POST http://localhost:4000/api/plugin/bootstrap -b cookies.txt`                          | Returns pluginToken and apps |
| Get credentials (no token)   | `curl -s http://localhost:4000/api/vault/credentials?appId=app_a`                                    | 401 Unauthorized             |
| Get credentials (with token) | `curl -s http://localhost:4000/api/vault/credentials?appId=app_a -H "Authorization: Bearer ptk_xxx"` | Returns credentials          |

---

## 6. Failure Simulation Tests

### Stop Single Vault Instance

```bash
# Stop 1 instance (system continues via round-robin)
docker stop vault-2
curl -s http://localhost:5000/health  # Should still work
```

### Stop Two Vault Instances

```bash
# Stop 2 instances (last one handles all)
docker stop vault-1
curl -s http://localhost:5000/health  # Should still work
```

### Stop All Vault Instances

```bash
# Stop all (nginx returns 502)
docker stop vault-3

# Try to access credentials - should fail
curl -s http://localhost:4000/api/vault/credentials?appId=app_a -H "Authorization: Bearer ptk_xxx"
# Expected: Error or service unavailable
```

### Restart Vault Instances

```bash
# Restart all
docker start vault-1 vault-2 vault-3

# Verify health
curl -s http://localhost:5000/health
```

### Test Replica Failure

```bash
# Stop replica (no impact on writes)
docker stop vault-postgres-replica-1

# Writes still work
curl -s -X POST http://localhost:5000/internal/vault/write \
  -H "Content-Type: application/json" \
  -d '{"vaultId":"test","appId":"app","fields":{"username":"test","password":"test"}}'

# Restart replica
docker start vault-postgres-replica-1
```

---

## 7. Round-Robin Load Balancing

### Verify Instance Distribution

```bash
# See which instance handles each request
for i in {1..9}; do
  curl -s http://localhost:5000/health | jq -r '.instance'
done
```

**Expected:** Responses should cycle through `vault-1`, `vault-2`, `vault-3`

---

## 8. View Logs

### Container Logs

```bash
docker logs vault-1 --tail 20
docker logs vault-2 --tail 20
docker logs vault-3 --tail 20
docker logs vault-lb --tail 20
docker logs postgres-primary --tail 20
```

### PID Logs

```bash
# Check terminal output when PID is running
# Shows: user login, token generation, vault proxy calls
```

---

## 9. Integration Tests

### Full User Flow

```bash
# 1. Login to PID
curl -s -X POST http://localhost:4000/login \
  -d "username=testuser&password=TestPass123!" \
  -c cookies.txt

# 2. Bootstrap to get token
RESPONSE=$(curl -s -X POST http://localhost:4000/api/plugin/bootstrap \
  -b cookies.txt)
echo $RESPONSE

# Extract token: ptk_xxx from response

# 3. Get credentials via extension API
curl -s http://localhost:4000/api/vault/credentials?appId=app_a \
  -H "Authorization: Bearer ptk_xxx"

# 4. Save new credentials
curl -s -X POST http://localhost:4000/api/vault/credentials \
  -H "Authorization: Bearer ptk_xxx" \
  -H "Content-Type: application/json" \
  -d '{"appId":"app_a","fields":{"username":"newuser","password":"newpass"}}'

# 5. Verify in Vault database
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT * FROM vault_credentials WHERE app_id = 'app_a';"
```

### Admin User Deletion (Cascade)

```bash
# 1. Create new user (via admin panel or API)
# ...

# 2. Delete user via admin
curl -s -X POST http://localhost:4000/admin/users/3/delete

# 3. Verify credentials deleted from Vault
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT * FROM vault_credentials WHERE vault_id = 'vault_3';"
# Expected: No rows returned
```

---

## 10. Quick Reference Commands

```bash
# Start everything
cd vault-service && docker-compose up -d && cd .. && cd primary-identity && npm start

# Check status
docker ps
curl -s http://localhost:5000/health | jq .
curl -s http://localhost:4000/api/session/status

# View credentials
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT * FROM vault_credentials;"

# View audit log
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT 10;"

# Stop everything
pkill -f "node.*primary-identity"
cd vault-service && docker-compose down && cd ..
```






.schema users

SELECT id, username, vault_id FROM users;  \\Check All Users With vault_id

 2️⃣ Check User ↔ App Mapping (Very Important)

 SELECT u.username, u.vault_id, a.appId
FROM users u
JOIN user_apps ua ON u.id = ua.user_id
JOIN apps a ON a.id = ua.app_id;

.exit

🟩 Next Step (Postgres Check)

cd vault-service
docker compose ps


docker exec -it postgres-primary psql -U vault_user -d vault_db      \\vault_secret

Inside Postgres run:

SELECT vault_id, app_id, fields
FROM vault_credentials
ORDER BY vault_id;

or

SELECT * FROM vault_credentials ;

replica check 

docker exec -it vault-postgres-replica-1 psql -U vault_user -d vault_db

Inside Postgres run:

SELECT vault_id, app_id, fields
FROM vault_credentials
ORDER BY vault_id;




in sql (PID)

.tables
.schema <table_name>     \\ apps           plugin_tokens  user_apps      users   
select * from <table_name> ;

eg{ 
sqlite> .tables
apps           plugin_tokens  user_apps      users        
sqlite> select * from apps
   ...> ;
1|app_a|http://localhost:3001|{"username":{"selector":"input[name='username']","type":"text"},"password":{"selector":"input[name='password']","type":"password"}}
2|app_b|http://localhost:3002|{"username":{"selector":"input[name='username']","type":"text"},"password":{"selector":"input[name='password']","type":"password"}}
3|app_c|http://localhost:3003|{"username":{"selector":"input[name='username']","type":"text"},"password":{"selector":"input[name='password']","type":"password"}}
4|app_d|http://localhost:3004|{"username":{"selector":"input[name='username']","type":"text"},"password":{"selector":"input[name='password']","type":"password"},"role":{"selector":"select[name='role']","type":"select"}}
sqlite> select * from plugin_tokens;
24|ptk_27d1d06ea36bbd8bda4587cbc9883878a6418364dfee8b91a08cbd84cd993344|3|["vault:read","vault:write"]|1770967477
25|ptk_27100b27f6f7727d832e7f4a07dbb97a11dd08939c20d9d9adaa68911cd66df8|3|["vault:read","vault:write"]|1770967504
sqlite> select * from user_apps;
2|1
2|2
2|3
2|4
3|1
3|2
3|4
sqlite> select * from user;
Parse error: no such table: user
sqlite> select * from users;
1|admin|$2a$10$P7di/KWRGr0Q.zNrDTz3teSJz1pD3VhoODehybNJtbGityqn7AwtO|admin|vault_1
2|testuser|$2a$10$T3ao5cpe8f6edD198Jrlm.3fhR9TkVuyWjg0w/R/RQCqLOZODh.0m|user|vault_2
3|ram|$2a$10$JJxGEoIpz9ODuGXvrxd7eurzzZni7TYHlXb77dq.YhLDVckKxNHBq|user|vault_3
7|tom|$2a$10$PjcWRHXIC9xBiXxIHN9n1OwE7P1R12Cl6cv4eHucJoqxpuem7KYUu|user|vault_7
}