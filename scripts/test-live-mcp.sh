#!/bin/bash
# scripts/test-live-mcp.sh
# Test the live Jules MCP Server endpoints

API_URL="https://antigravity-jules-orchestration.onrender.com"

echo "🔍 Testing Jules MCP Server at $API_URL"
echo "======================================="

# 1. Test Root
echo "1. Checking Service Metadata..."
curl -s "$API_URL/" | grep -q "Jules MCP Server" && echo "✅ Metadata OK" || echo "❌ Metadata Failed"

# 2. Test Health
echo "2. Checking Health..."
HEALTH=$(curl -s "$API_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "✅ Health OK"
else
    echo "❌ Health Check Failed: $HEALTH"
fi

# 3. List Tools
echo "3. Listing MCP Tools..."
TOOLS=$(curl -s "$API_URL/mcp/tools")
if echo "$TOOLS" | grep -q "jules_create_session"; then
    echo "✅ Tools List OK"
else
    echo "❌ Tools List Failed"
fi

# 4. Simulate Tool Execution (Dry Run/List Sessions)
echo "4. Testing Tool Execution (jules_list_sessions)..."
EXEC_RESPONSE=$(curl -s -X POST "$API_URL/mcp/execute" \
  -H "Content-Type: application/json" \
  -d '{ 
    "name": "jules_list_sessions", 
    "arguments": {} 
  }')

if echo "$EXEC_RESPONSE" | grep -q "content"; then
    echo "✅ Tool Execution OK"
    echo "   Response sample: $(echo $EXEC_RESPONSE | cut -c 1-100)..."
else
    echo "❌ Tool Execution Failed: $EXEC_RESPONSE"
fi

echo ""
echo "🚀 Test Complete"
