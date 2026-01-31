#!/bin/bash
# Startup script for all services
# Uses subshells ( ) to ensure directory changes don't affect the main script

echo "🚀 Starting all services..."
echo ""

# Kill any existing processes
echo "🛑 Stopping any existing services..."
./stop-all.sh > /dev/null 2>&1
sleep 1

# Start Primary Identity
echo "▶️  Starting Primary Identity (port 4000)..."
(cd primary-identity && npm start > /tmp/primary-identity.log 2>&1 &)
sleep 2

# Start APP1
echo "▶️  Starting APP1 (port 3001)..."
(cd APP1 && node app.js > /tmp/app1.log 2>&1 &)
sleep 1

# Start APP2
echo "▶️  Starting APP2 (port 3002)..."
(cd APP2 && node app.js > /tmp/app2.log 2>&1 &)
sleep 1

# Start APP3
echo "▶️  Starting APP3 (port 3003)..."
(cd APP3 && node app.js > /tmp/app3.log 2>&1 &)
sleep 1

# Start APP4
echo "▶️  Starting APP4 (port 3004)..."
(cd APP4 && node app.js > /tmp/app4.log 2>&1 &)
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
    if lsof -i:$port > /dev/null 2>&1; then
        echo "✓ $name (http://localhost:$port) - Running"
    else
        echo "✗ $name - FAILED TO START"
    fi
}

check_service 4000 "Primary Identity"
check_service 3001 "APP1"
check_service 3002 "APP2"
check_service 3003 "APP3"
check_service 3004 "APP4"
check_service 3100 "Launcher"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 Logs are saved in /tmp/"
echo "   - Primary Identity: /tmp/primary-identity.log"
echo "   - APP1: /tmp/app1.log"
echo "   - APP2: /tmp/app2.log"
echo "   - APP3: /tmp/app3.log"
echo "   - APP4: /tmp/app4.log"
echo "   - Launcher: /tmp/launcher.log"
echo ""
echo "🔍 To view logs: tail -f /tmp/primary-identity.log"
echo "🛑 To stop all: ./stop-all.sh (or pkill -f 'node app.js')"
