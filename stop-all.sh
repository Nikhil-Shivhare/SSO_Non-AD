#!/bin/bash
# Stop all running services

echo "🛑 Stopping all services..."
echo ""

# Kill processes on specific ports
lsof -ti:4000 | xargs kill -9 2>/dev/null && echo "✓ Stopped Primary Identity (port 4000)"
lsof -ti:3001 | xargs kill -9 2>/dev/null && echo "✓ Stopped Session based App (App A) (port 3001)"
lsof -ti:3002 | xargs kill -9 2>/dev/null && echo "✓ Stopped Session + CSRF App (App B) (port 3002)"
lsof -ti:3003 | xargs kill -9 2>/dev/null && echo "✓ Stopped Stateless App (App C) (port 3003)"
lsof -ti:3004 | xargs kill -9 2>/dev/null && echo "✓ Stopped Role-based login App (App D) (port 3004)"
lsof -ti:3005 | xargs kill -9 2>/dev/null && echo "✓ Stopped SAML App (App E) (port 3005)"
lsof -ti:3006 | xargs kill -9 2>/dev/null && echo "✓ Stopped OIDC App (App F) (port 3006)"
lsof -ti:3100 | xargs kill -9 2>/dev/null && echo "✓ Stopped Launcher (port 3100)"

echo ""
echo "✅ All services stopped!"
