#!/bin/bash
# Startup script for all services
# Uses subshells ( ) to ensure directory changes don't affect the main script

echo "🚀 Starting all services..."
echo ""

# Kill any existing processes
echo "🛑 Stopping any existing services..."
./stop-all.sh > /dev/null 2>&1
sleep 1

# Start Vault Service (Docker)
echo "▶️  Starting Vault Service (Docker)..."
(cd vault-service && docker-compose up -d > /tmp/vault-service.log 2>&1)
echo "   Waiting for Vault to be ready..."
sleep 7

# Verify Vault is running
VAULT_HEALTH=$(curl -s http://localhost:5000/health 2>/dev/null | jq -r '.status' 2>/dev/null)
if [ "$VAULT_HEALTH" = "ok" ]; then
    echo "   ✓ Vault Service is healthy"
else
    echo "   ⚠️  Vault Service may not be ready yet"
fi

# Start Primary Identity (PID — Python/FastAPI)
echo "▶️  Starting Primary Identity (port 4000)..."
(cd PID && source venv/bin/activate && python app.py > /tmp/primary-identity.log 2>&1 &)
sleep 2

# Start Session based App (App A)
echo "▶️  Starting Session based App (App A) (port 3001)..."
(cd "Session based App (App A)" && node app.js > /tmp/app1.log 2>&1 &)
sleep 1

# Start Session + CSRF App (App B)
echo "▶️  Starting Session + CSRF App (App B) (port 3002)..."
(cd "Session + CSRF App (App B)" && node app.js > /tmp/app2.log 2>&1 &)
sleep 1

# Start Stateless App (App C)
echo "▶️  Starting Stateless App (App C) (port 3003)..."
(cd "Stateless App (App C)" && node app.js > /tmp/app3.log 2>&1 &)
sleep 1

# Start Role-based login App (App D)
echo "▶️  Starting Role-based login App (App D) (port 3004)..."
(cd "Role-based login App (App D)" && node app.js > /tmp/app4.log 2>&1 &)
sleep 1

# Start Launcher
echo "▶️  Starting Launcher (port 3100)..."
(cd launcher && node app.js > /tmp/launcher.log 2>&1 &)
sleep 2

echo ""
echo "✅ All services started!"
echo ""
echo "📊 Service Status:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check each service
check_service() {
    local port=$1
    local name=$2
    if nc -z localhost $port > /dev/null 2>&1; then
        echo "✓ $name (http://localhost:$port) - Running"
    else
        echo "✗ $name - FAILED TO START"
    fi
}

check_service 5000 "Vault Service"
check_service 4000 "Primary Identity"
check_service 3001 "Session based App (App A)"
check_service 3002 "Session + CSRF App (App B)"
check_service 3003 "Stateless App (App C)"
check_service 3004 "Role-based login App (App D)"
check_service 3100 "Launcher"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 Logs are saved in /tmp/"
echo "   - Vault Service: /tmp/vault-service.log"
echo "   - Primary Identity: /tmp/primary-identity.log"
echo "   - Session based App (App A): /tmp/app1.log"
echo "   - Session + CSRF App (App B): /tmp/app2.log"
echo "   - Stateless App (App C): /tmp/app3.log"
echo "   - Role-based login App (App D): /tmp/app4.log"
echo "   - Launcher: /tmp/launcher.log"
echo ""
echo "🔍 To view logs: tail -f /tmp/primary-identity.log"
echo "🛑 To stop all: ./stop-all.sh"
