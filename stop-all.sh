#!/bin/bash
# Stop all running services

echo "🛑 Stopping all services..."
echo ""

# Kill processes on specific ports
lsof -ti:4000 | xargs kill -9 2>/dev/null && echo "✓ Stopped Primary Identity (port 4000)"
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "✓ Stopped APP1 (port 3001)"
lsof -ti:3002 | xargs kill -9 2>/dev/null && echo "✓ Stopped APP2 (port 3002)"
lsof -ti:3003 | xargs kill -9 2>/dev/null && echo "✓ Stopped APP3 (port 3003)"
lsof -ti:3004 | xargs kill -9 2>/dev/null && echo "✓ Stopped APP4 (port 3004)"
lsof -ti:3100 | xargs kill -9 2>/dev/null && echo "✓ Stopped Launcher (port 3100)"

echo ""
echo "✅ All services stopped!"
