# Testing Commands

## Start Everything

```bash
# 1. Start Vault Service (Postgres + 3 Vault instances + nginx)
cd vault-service && docker-compose up -d && cd ..

# 2. Start Primary Identity Service
cd primary-identity && npm start
```

## Stop Everything

```bash
# 1. Stop PID (Ctrl+C in terminal, or:)
pkill -f "node.*primary-identity"

# 2. Stop Vault Service (all containers)
cd vault-service && docker-compose down && cd ..
```

---

## Check Status

```bash
# All containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Vault health (shows which instance responds)
curl -s http://localhost:5000/health | jq .

# PID health
curl -s http://localhost:4000/ | head -c 100
```

---

## View Stored Credentials

```bash
# All credentials (primary DB, port 5433)
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT vault_id, app_id, fields, created_at FROM vault_credentials;"

# Count of credentials
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT COUNT(*) FROM vault_credentials;"

# Credentials for a specific user (replace VAULT_ID)
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT * FROM vault_credentials WHERE vault_id = 'VAULT_ID';"

# View on replica (port 5434, should match primary)
PGPASSWORD=vault_secret psql -h localhost -p 5434 -U vault_user -d vault_db \
  -c "SELECT vault_id, app_id, fields FROM vault_credentials;"

# Audit log (who accessed what)
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "SELECT * FROM audit_log ORDER BY performed_at DESC LIMIT 20;"
```

---

## Read/Write Credentials via API

```bash
# Write
curl -s -X POST http://localhost:5000/internal/vault/write \
  -H "Content-Type: application/json" \
  -d '{"vaultId":"test_vault","appId":"test_app","fields":{"username":"myuser","password":"mypass"}}' | jq .

# Read
curl -s -X POST http://localhost:5000/internal/vault/read \
  -H "Content-Type: application/json" \
  -d '{"vaultId":"test_vault","appId":"test_app"}' | jq .

# Delete
curl -s -X POST http://localhost:5000/internal/vault/delete \
  -H "Content-Type: application/json" \
  -d '{"vaultId":"test_vault","appId":"test_app"}' | jq .
```

---

## Round-Robin Verification

```bash
# See which instance handles each request
for i in {1..9}; do
  curl -s http://localhost:5000/health | jq -r '.instance'
done
```

---

## Failure Simulation

```bash
# Stop 1 instance (system continues)
docker stop vault-2

# Stop 2 instances (last one handles all)
docker stop vault-1

# Stop all (nginx returns 502)
docker stop vault-3

# Restart all
docker start vault-1 vault-2 vault-3

# Stop/start replica (no impact on writes)
docker stop vault-postgres-replica-1
docker start vault-postgres-replica-1
```

---

## View Instance Logs

```bash
docker logs vault-1 --tail 20
docker logs vault-2 --tail 20
docker logs vault-3 --tail 20
docker logs vault-lb --tail 20
```

---

## DB Schema Check

```bash
# List all tables
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "\dt"

# Describe vault_credentials table
PGPASSWORD=vault_secret psql -h localhost -p 5433 -U vault_user -d vault_db \
  -c "\d vault_credentials"
```
